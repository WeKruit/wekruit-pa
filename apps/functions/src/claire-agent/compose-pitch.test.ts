/**
 * compose-pitch.test.ts — the pure projection + fail-open contract of the pitch engine.
 * The live gpt-5.4-mini call is exercised by the live smoke (scripts), not here.
 *   node --import tsx --test apps/functions/src/claire-agent/compose-pitch.test.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildPitchProfile,
  composePitchTurn,
  defaultPitchComposer,
  isThinEvidence,
  isValidComposedCloser,
  isValidComposedConfirmation,
  pickBestResume,
  type PitchComposer,
  type TurnFramingComposer,
  type TurnFramingContext,
} from "./compose-pitch.js"

/**
 * A tiny in-memory Firestore stub good enough for composePitchTurn: a single pa-users doc + a (possibly
 * seeded) parsedCandidateResumes query, and it records set(merge:true) writes so we can assert the
 * once-only evidenceAskedAt / pitchedAt stamps. `resumeRows` seeds the parsedCandidateResumes query (the
 * first non-empty of userId/candidateId wins, matching composePitchTurn).
 */
function makeStubDb(userDoc: Record<string, unknown>, resumeRows: Record<string, unknown>[] = []) {
  const writes: Record<string, unknown>[] = []
  const db = {
    collection(name: string) {
      if (name === "parsedCandidateResumes") {
        return {
          where: () => ({
            async get() {
              return {
                empty: resumeRows.length === 0,
                docs: resumeRows.map((r) => ({ data: () => r })),
              }
            },
          }),
        }
      }
      // pa-users (or anything else): one doc, set() records, get() returns the doc.
      return {
        doc: () => ({
          async get() { return { exists: true, data: () => userDoc } },
          async set(patch: Record<string, unknown>) { writes.push(patch); return undefined },
        }),
        where: () => ({ async get() { return { empty: true, docs: [] } } }),
      }
    },
  } as unknown as import("firebase-admin/firestore").Firestore
  return { db, writes }
}

test("isThinEvidence: true when no highlight carries a real impact description (LinkedIn-only)", () => {
  const thin = buildPitchProfile({
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme", skills: [{ name: "TypeScript" }] },
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }], // title+company only
  })
  assert.equal(isThinEvidence(thin), true)
})

test("isThinEvidence: false when a highlight has a real (>=40 char) impact description", () => {
  const rich = buildPitchProfile(
    { tags: { recentRoleTitle: "SWE", recentCompany: "Acme" } },
    {
      experiences: [
        { title: "SWE", company: "Acme", description: "Built voice infra handling thousands of calls/day; cut latency 40%." },
      ],
    },
  )
  assert.equal(isThinEvidence(rich), false)
})

test("buildPitchProfile projects name/title/company/skills/highlights from the pa-users doc", () => {
  const p = buildPitchProfile({
    displayName: "Adam Yang",
    experienceHighlights: [
      { title: "Senior Software Engineer", company: "Tesla", description: "V&C portfolio for 300+ stores; Azure migration.", durationMonths: 11, companyIndustry: "automotive" },
      { title: "Founder", company: "aiStudy", description: "LLM/RAG, +10% AUC.", durationMonths: 5 },
    ],
    tags: {
      recentRoleTitle: "Senior Software Engineer",
      recentCompany: "Tesla",
      skills: [{ name: "TypeScript" }, "Kubernetes", { name: "Azure" }],
    },
  })
  assert.equal(p.name, "Adam")
  assert.equal(p.recentRoleTitle, "Senior Software Engineer")
  assert.equal(p.recentCompany, "Tesla")
  assert.deepEqual(p.skills, ["TypeScript", "Kubernetes", "Azure"])
  assert.equal(p.experienceHighlights.length, 2)
  assert.equal(p.experienceHighlights[0]?.company, "Tesla")
})

test("buildPitchProfile prefers the parsed RÉSUMÉ (descriptions + topSkills) over LinkedIn", () => {
  const userDoc = {
    displayName: "Adam Yang",
    tags: { recentRoleTitle: "Senior Software Engineer", recentCompany: "Tesla", skills: [{ name: "housing" }, { name: "reward_management" }] },
    experienceHighlights: [{ title: "Senior Software Engineer", company: "Tesla" }], // no description (LinkedIn)
  }
  const resume = {
    topSkills: ["TypeScript", "Kubernetes", "Voice Infrastructure"],
    experiences: [
      { title: "Voice Lead", company: "Tesla", description: "Built voice infrastructure handling thousands of calls per day; cut latency 40%." },
      { title: "Founder", company: "aiStudy", description: "LLM/RAG knowledge tracing, +10% AUC." },
    ],
  }
  const p = buildPitchProfile(userDoc, resume)
  // résumé experiences (with descriptions) win
  assert.equal(p.experienceHighlights[0]?.description?.includes("voice infrastructure"), true)
  // real résumé skills win over the junk Coresignal tokens
  assert.deepEqual(p.skills, ["TypeScript", "Kubernetes", "Voice Infrastructure"])
  assert.equal(p.skills.includes("housing"), false)
})

test("buildPitchProfile reads experienceHighlights from tags as a fallback", () => {
  const p = buildPitchProfile({ tags: { experienceHighlights: [{ title: "PM", company: "Acme" }] } })
  assert.equal(p.experienceHighlights.length, 1)
  assert.equal(p.experienceHighlights[0]?.company, "Acme")
})

test("buildPitchProfile MERGES résumé depth with LinkedIn breadth (Adam: 'it's an OR — always adding values')", () => {
  // LinkedIn = breadth (every role, description-less); résumé = depth (real descriptions). The merge must
  // KEEP LinkedIn-only roles, ADD résumé-only roles, and merge a SHARED role ONCE (résumé description wins)
  // — no source thrown away, no duplicate.
  const userDoc = {
    displayName: "Adam Yang",
    tags: { recentRoleTitle: "Senior Software Engineer", recentCompany: "Tesla" },
    experienceHighlights: [
      { title: "Senior Software Engineer", company: "Tesla" }, // shared role (LinkedIn, no description)
      { title: "Volunteer", company: "RedCross" }, // LinkedIn-only role the résumé omits
    ],
  }
  const resume = {
    topSkills: ["node.js"],
    experiences: [
      { title: "Senior Software Engineer", company: "Tesla", description: "Built the in-store voice system across 300+ stores; cut latency 40%." },
      { title: "Founder", company: "aiStudy", description: "Shipped an AI study product 0→1; RAG + knowledge tracing." }, // résumé-only role
    ],
  }
  const p = buildPitchProfile(userDoc, resume)
  const keys = p.experienceHighlights.map((h) => `${h.company}|${h.title}`)
  assert.ok(keys.includes("aiStudy|Founder"), "résumé-only role ADDED (depth)")
  assert.ok(keys.includes("RedCross|Volunteer"), "LinkedIn-only role KEPT (breadth) — not thrown away")
  // shared Tesla role merged ONCE, carrying the résumé description (no duplicate, no description lost)
  const tesla = p.experienceHighlights.filter((h) => h.company === "Tesla")
  assert.equal(tesla.length, 1, "shared role appears exactly once")
  assert.equal(tesla[0]?.description?.includes("300+ stores"), true, "merged role keeps the résumé description")
  // described highlights lead so the pitch's achievement layer reads them first
  assert.ok(p.experienceHighlights[0]?.description, "a described highlight leads")
})

test("composePitchTurn FAILS OPEN (null) when the user has no pitchable signal", async () => {
  const db = {
    collection: () => ({
      doc: () => ({ async get() { return { exists: true, data: () => ({ tags: {} }) } } }),
    }),
  } as unknown as import("firebase-admin/firestore").Firestore
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z")
  assert.equal(out, null) // no title/company/highlights/skills → fall through to the agent path
})

test("composePitchTurn FAILS OPEN (null) when the user doc is missing", async () => {
  const db = {
    collection: () => ({ doc: () => ({ async get() { return { exists: false, data: () => undefined } } }) }),
  } as unknown as import("firebase-admin/firestore").Firestore
  assert.equal(await composePitchTurn(db, "ghost", "2026-06-04T00:00:00Z"), null)
})

// R2 (Adam 2026-06-04): pitch composition is a swappable PitchComposer; composePitchTurn defaults to it.
test("R2: defaultPitchComposer is exported and satisfies the PitchComposer interface", () => {
  const composer: PitchComposer = defaultPitchComposer
  assert.equal(typeof composer.compose, "function")
})

test("R2: composePitchTurn uses the injected composer (swappable strategy)", async () => {
  // LinkedIn-only profile: real signal (title+company) but NO impact description → thin.
  const { db } = makeStubDb({
    displayName: "Adam Yang",
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme" },
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }],
  })
  let sawProfile = false
  const mock: PitchComposer = {
    async compose(profile) {
      sawProfile = profile.name === "Adam" && profile.recentCompany === "Acme"
      return "MOCK_PITCH_TEXT"
    },
  }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  assert.notEqual(out, null)
  assert.equal(out!.length, 3) // [confirmation, pitch, offer]
  assert.equal(out![1], "MOCK_PITCH_TEXT") // the injected composer's output is used verbatim
  assert.equal(sawProfile, true) // composer received the built profile
})

test("R4: thin profile gets the SHORT, optional evidence-ask copy (once)", async () => {
  const { db, writes } = makeStubDb({
    displayName: "Adam Yang",
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme" },
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }], // thin (no description)
  })
  const mock: PitchComposer = { async compose() { return "pitch" } }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  const offer = out![2]!
  // Adam's exact spirit: "i already know about you — share more (a few words, a voice note, or your
  // résumé) so i match you better, or i can pull matches now if you want."
  assert.match(offer, /i already know about you/)
  assert.match(offer, /a few words/)
  assert.match(offer, /a voice note/)
  assert.match(offer, /résumé/)
  assert.match(offer, /pull matches now/)
  // SHORT: one sentence, no nagging multi-paragraph copy.
  assert.ok(offer.length < 160, `offer should be short, got ${offer.length} chars`)
  // Once-only: evidenceAskedAt is stamped so we never nag again.
  assert.ok(writes.some((w) => typeof (w as { evidenceAskedAt?: unknown }).evidenceAskedAt === "string"))
})

// ─── #2 PITCH SOFT-CONFIRM (Adam 2026-06-05): the pitch offer ends with a LIGHT one-line confirm of the
// auto-derived role (tags.targetRoleFunction) BEFORE recs — conversational, not a wall. ───

test("#2: offer bubble ends with the LIGHT role soft-confirm on the NORMAL variant", async () => {
  const { db } = makeStubDb({
    displayName: "Adam Yang",
    evidenceAskedAt: "2026-06-03T00:00:00Z", // already asked → normal OFFER_BUBBLE branch
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme", targetRoleFunction: ["software_engineering"] },
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }],
  })
  const mock: PitchComposer = { async compose() { return "PITCH" } }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  assert.equal(out!.length, 3, "still [confirmation, pitch, offer]")
  assert.equal(out![1], "PITCH", "the railed pitch bubble is UNCHANGED (no confirm leaked into it)")
  assert.match(out![2]!, /^targeting software engineering roles — that right\? 👍 /, "offer leads with the soft-confirm")
})

test("#2: soft-confirm fires on the RICH-résumé variant too", async () => {
  const { db } = makeStubDb(
    {
      displayName: "Adam Yang",
      tags: { recentRoleTitle: "Senior Software Engineer", recentCompany: "Tesla", targetRoleFunction: ["software_engineering"] },
      experienceHighlights: [{ title: "Senior Software Engineer", company: "Tesla" }],
    },
    [
      {
        createdAt: ts("2026-06-05T01:45:00Z"),
        experiences: [{ title: "Founder", company: "AI Study", description: "Shipped an AI study product 0→1 with RAG; +10% AUC over baseline metrics." }],
        topSkills: ["node.js"],
      },
    ],
  )
  const mock: PitchComposer = { async compose() { return "PITCH" } }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  // SINGLE CLEAR ACTION (Adam 2026-06-06): the rich-résumé offer is now one unambiguous ask
  // ("want me to pull some roles that fit you right now?") so a plain "sure" maps to find_match.
  assert.match(out![2]!, /^targeting software engineering roles — that right\? 👍 want me to pull some roles that fit you right now\?/)
})

test("#2: soft-confirm fires on the THIN evidence-ask variant too", async () => {
  const { db } = makeStubDb({
    displayName: "Adam Yang",
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme", targetRoleFunction: ["software_engineering"] },
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }], // thin, never asked → OFFER_BUBBLE_THIN
  })
  const mock: PitchComposer = { async compose() { return "PITCH" } }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  assert.match(out![2]!, /^targeting software engineering roles — that right\? 👍 i already know about you/)
})

test("#2: an _and_ role token humanizes to '&' in the soft-confirm", async () => {
  const { db } = makeStubDb({
    displayName: "Pat",
    evidenceAskedAt: "2026-06-03T00:00:00Z",
    tags: { recentRoleTitle: "Accountant", recentCompany: "Acme", targetRoleFunction: ["accounting_and_finance"] },
    experienceHighlights: [{ title: "Accountant", company: "Acme" }],
  })
  const mock: PitchComposer = { async compose() { return "PITCH" } }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  assert.match(out![2]!, /^targeting accounting & finance roles — that right\? 👍 /)
})

test("#2: a multi-pick role joins the first two lanes with ' / '", async () => {
  const { db } = makeStubDb({
    displayName: "Sam",
    evidenceAskedAt: "2026-06-03T00:00:00Z",
    tags: {
      recentRoleTitle: "Founder",
      recentCompany: "aiStudy",
      targetRoleFunction: ["software_engineering", "product_management"],
    },
    experienceHighlights: [{ title: "Founder", company: "aiStudy" }],
  })
  const mock: PitchComposer = { async compose() { return "PITCH" } }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  assert.match(out![2]!, /^targeting software engineering \/ product management roles — that right\? 👍 /)
})

test("#2: NO derived role → offer is the verbatim current string (no dangling 'targeting — that right?')", async () => {
  const { db } = makeStubDb({
    displayName: "Adam Yang",
    evidenceAskedAt: "2026-06-03T00:00:00Z",
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme" }, // no targetRoleFunction
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }],
  })
  const mock: PitchComposer = { async compose() { return "PITCH" } }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  assert.doesNotMatch(out![2]!, /targeting/)
  assert.doesNotMatch(out![2]!, /that right/)
  assert.match(out![2]!, /^want me to pull roles that fit this now/) // verbatim OFFER_BUBBLE
})

test("R4: thin profile that was ALREADY asked does NOT repeat the evidence ask", async () => {
  const { db } = makeStubDb({
    displayName: "Adam Yang",
    evidenceAskedAt: "2026-06-03T00:00:00Z", // already asked once
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme" },
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }],
  })
  const mock: PitchComposer = { async compose() { return "pitch" } }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  const offer = out![2]!
  assert.doesNotMatch(offer, /i already know about you/) // falls back to the normal offer, no re-ask
})

// ─── #4 RE-PITCH: résumé must SHARPEN the pitch (Adam 2026-06-04, "improve the pitch after résumé") ───

/** Fake Firestore Timestamp — the prod shape that broke the old String(createdAt).localeCompare sort. */
function ts(iso: string) {
  const ms = Date.parse(iso)
  return { toMillis: () => ms, seconds: Math.floor(ms / 1000) }
}

test("pickBestResume: picks the description-RICH row even when the description-LESS row is NEWER (Timestamp)", () => {
  // The live case-B bug: the LinkedIn/Coresignal parse (description-less) was newer than the real PDF, and
  // the broken String(Timestamp).localeCompare sort (no-op → all 0) left docs[0] = arbitrary order. The
  // fix prefers a row with real descriptions, tie-broken by newest. Here the rich PDF is the OLDER row.
  const coresignalRow = {
    createdAt: ts("2026-06-05T01:45:09Z"), // NEWER
    experiences: [{ title: "Senior Software Engineer", company: "Tesla" }], // no description (thin)
    topSkills: ["communication skills", "trilingual", "engineer"],
  }
  const realPdfRow = {
    createdAt: ts("2026-06-05T01:41:00Z"), // OLDER
    experiences: [
      { title: "Founder, Software Engineer & Product Manager", company: "AI Study", description: "Founded and shipped an AI study product 0→1; built RAG + knowledge tracing." },
    ],
    topSkills: ["node.js", "react.js", "flask"],
  }
  const best = pickBestResume([coresignalRow, realPdfRow])
  // The DESCRIPTION-RICH PDF wins despite being older — that's the technical-detail source.
  assert.equal((best as typeof realPdfRow).topSkills.includes("node.js"), true)
  assert.equal((best as { experiences: { description?: string }[] }).experiences[0]?.description?.includes("0→1"), true)
})

test("pickBestResume: among rich rows, newest wins; with NO descriptions, newest overall", () => {
  const olderRich = { createdAt: ts("2026-06-01T00:00:00Z"), experiences: [{ description: "Built a payments platform serving millions of transactions per day." }] }
  const newerRich = { createdAt: ts("2026-06-04T00:00:00Z"), experiences: [{ description: "Led the migration of a monolith to microservices across 12 teams." }] }
  const best = pickBestResume([olderRich, newerRich])
  assert.equal((best as { experiences: { description?: string }[] }).experiences[0]?.description?.includes("monolith"), true)

  const thinOld = { createdAt: ts("2026-06-01T00:00:00Z"), experiences: [{ title: "PM" }] }
  const thinNew = { createdAt: ts("2026-06-04T00:00:00Z"), experiences: [{ title: "SWE" }] }
  const bestThin = pickBestResume([thinOld, thinNew])
  assert.equal((bestThin as { experiences: { title?: string }[] }).experiences[0]?.title, "SWE") // newest overall
})

test("composePitchTurn feeds the RÉSUMÉ (not LinkedIn) experiences to the composer when a rich résumé exists", async () => {
  // LinkedIn-only userDoc (thin) + a parsed résumé with real descriptions → buildPitchProfile must use the
  // résumé experiences, proving the drop sharpens the pitch (the composer sees the technical detail).
  const { db } = makeStubDb(
    {
      displayName: "Adam Yang",
      tags: { recentRoleTitle: "Senior Software Engineer", recentCompany: "Tesla", skills: [{ name: "housing" }] },
      experienceHighlights: [{ title: "Senior Software Engineer", company: "Tesla" }], // LinkedIn, no description
    },
    [
      {
        createdAt: ts("2026-06-05T01:45:00Z"),
        experiences: [{ title: "Founder", company: "AI Study", description: "Shipped an AI study product 0→1 with RAG + knowledge tracing; +10% AUC." }],
        topSkills: ["node.js", "react.js", "flask"],
      },
    ],
  )
  let seenProfile: { isThin: boolean; skills: string[] } | null = null
  const mock: PitchComposer = {
    async compose(profile) {
      seenProfile = { isThin: isThinEvidence(profile), skills: profile.skills }
      return "PITCH"
    },
  }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  assert.notEqual(out, null)
  // The composer received the RÉSUMÉ profile: NOT thin (it carries the founder description) + résumé skills.
  assert.equal(seenProfile!.isThin, false)
  assert.equal(seenProfile!.skills.includes("node.js"), true)
  assert.equal(seenProfile!.skills.includes("housing"), false)
})

test("composePitchTurn IMPROVED re-entry: distinct confirmation + improved flag + NO evidence re-ask", async () => {
  // pitchedAt set (a first pitch already ran) + a description-rich résumé just landed → the IMPROVED pass.
  let improvedFlag: boolean | undefined
  const { db, writes } = makeStubDb(
    {
      displayName: "Adam Yang",
      pitchedAt: "2026-06-04T00:00:00Z", // FIRST pitch already happened
      onboardingStatus: "complete",
      tags: { recentRoleTitle: "Senior Software Engineer", recentCompany: "Tesla" },
      experienceHighlights: [{ title: "Senior Software Engineer", company: "Tesla" }],
    },
    [
      {
        createdAt: ts("2026-06-05T02:00:00Z"),
        experiences: [{ title: "Founder", company: "AI Study", description: "Shipped an AI study product 0→1; RAG + knowledge tracing, +10% AUC over baseline." }],
        topSkills: ["node.js", "react.js"],
      },
    ],
  )
  const mock: PitchComposer = {
    async compose(profile) {
      improvedFlag = profile.improved
      return "SHARPER_PITCH_WITH_TECH_DETAIL"
    },
  }
  const out = await composePitchTurn(db, "u1", "2026-06-05T02:01:00Z", mock)
  assert.notEqual(out, null)
  const [confirmation, pitch, offer] = out!
  // Distinct improved-pitch confirmation — acknowledges the RÉSUMÉ + added technical detail, and is NOT
  // the first-pitch "pulled your … from linkedin" (so it never reads like a repeat / near-dup).
  assert.match(confirmation!, /résumé|resume|technical detail/i)
  assert.doesNotMatch(confirmation!, /from linkedin/i)
  // Composer told it's the improved pass → leans into the résumé's technical detail.
  assert.equal(improvedFlag, true)
  assert.equal(pitch, "SHARPER_PITCH_WITH_TECH_DETAIL")
  // We just GOT the résumé → no "share more (résumé)" evidence re-ask.
  assert.doesNotMatch(offer!, /i already know about you/)
  // pitchedAt is (re)stamped on the improved turn too.
  assert.ok(writes.some((w) => typeof (w as { pitchedAt?: unknown }).pitchedAt === "string"))
})

test("composePitchTurn FIRST pitch (no pitchedAt) keeps the original linkedin confirmation + improved=false", async () => {
  let improvedFlag: boolean | undefined
  const { db } = makeStubDb({
    displayName: "Adam Yang",
    tags: { recentRoleTitle: "Senior Software Engineer", recentCompany: "Tesla" },
    experienceHighlights: [{ title: "Senior Software Engineer", company: "Tesla", description: "Owned the in-store voice system end to end across 300+ stores." }],
  })
  const mock: PitchComposer = {
    async compose(profile) { improvedFlag = profile.improved; return "FIRST_PITCH" },
  }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", mock)
  assert.match(out![0]!, /from linkedin/i) // first-pitch framing
  assert.notEqual(improvedFlag, true) // not the improved pass
})

// ─── ROOT CAUSE (Adam 2026-06-04): the real achievement text lives in workHistory[].bullets + projects[],
// NOT experiences[].description (the parser flattens that to a bare title). buildPitchProfile MUST source
// it from there or the pitch is starved of technical detail and hallucinates. ───

test("buildPitchProfile sources achievement text from workHistory[].bullets (not the title-only experiences description)", () => {
  const resume = {
    // experiences carry only a title-echo "description" (what the parser actually stores) — useless as proof
    experiences: [{ title: "Software Engineer Intern", company: "Tesla", description: "Software Engineer Intern." }],
    // the REAL proof is the bullets
    workHistory: [
      {
        title: "Software Engineer Intern",
        company: "Tesla",
        bullets: [
          "Contributed to a V&C management portfolio used by 300+ stores worldwide with Node.js and React.",
          "Built a CI/CD pipeline with Kubernetes and Docker.",
        ],
      },
    ],
    projects: [
      { name: "Paxos KV Store", description: "Designed a fault-tolerant sharded key/value store using Paxos replication, tested under unreliable networks." },
    ],
  }
  const p = buildPitchProfile({ tags: { recentRoleTitle: "SWE", recentCompany: "Tesla" } }, resume)
  const tesla = p.experienceHighlights.find((h) => h.company === "Tesla")
  assert.ok(tesla?.description?.includes("300+ stores"), "workHistory bullet text is surfaced (not the title echo)")
  assert.equal(p.experienceHighlights.some((h) => h.title === "Paxos KV Store"), true, "a project is surfaced as a highlight")
  assert.equal(isThinEvidence(p), false, "real bullets make the profile non-thin")
})

test("pickBestResume: a workHistory-bullets PDF beats a description-LESS Coresignal row even when the Coresignal row is NEWER", () => {
  // The live shape: Coresignal parse = newer, rich metadata, but every experiences[].description is null +
  // no bullets. PDF parse = older, but workHistory carries the real achievement bullets. The bullets doc must win.
  const coresignal = {
    createdAt: ts("2026-06-05T02:00:00Z"), // NEWER
    experiences: [{ title: "Senior Software Engineer", company: "Tesla", description: null }],
    coresignalEmployeeId: "abc",
  }
  const pdf = {
    createdAt: ts("2026-06-05T01:00:00Z"), // OLDER
    experiences: [{ title: "SWE Intern", company: "Tesla", description: "SWE Intern." }], // title echo only
    workHistory: [{ title: "SWE Intern", company: "Tesla", bullets: ["Shipped a system used by 300+ stores worldwide."] }],
  }
  const best = pickBestResume([coresignal, pdf])
  assert.ok(Array.isArray((best as { workHistory?: unknown[] }).workHistory), "the bullets-carrying PDF is picked, not the newer description-less Coresignal row")
})

// ─── Fix B (Adam 2026-06-07: "the main thing is to avoid the agent generating same texts again and
// again"). The confirmation + closer are now MODEL-COMPOSED (varied) with a SAFETY FALLBACK to the locked
// single-clear-pull-ask template. ───

test("framing: composePitchTurn uses the model-composed {confirmation, closer} when valid", async () => {
  const { db } = makeStubDb({
    displayName: "Adam Yang",
    evidenceAskedAt: "2026-06-03T00:00:00Z", // normal path (NOT the thin-evidence ask)
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme", targetRoleFunction: ["software_engineering"] },
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }],
  })
  const pitch: PitchComposer = { async compose() { return "PITCH" } }
  let sawRoleLabel: string | null | undefined
  const framing: TurnFramingComposer = {
    async composeFraming(ctx: TurnFramingContext) {
      sawRoleLabel = ctx.roleLabel
      return {
        confirmation: "ok, pulled your acme background 🙌",
        closer: "you're after software roles — want me to go find some fits right now?",
      }
    },
  }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", pitch, framing)
  assert.equal(out!.length, 3)
  assert.equal(out![0], "ok, pulled your acme background 🙌", "composed confirmation is used")
  assert.equal(out![1], "PITCH", "pitch body unchanged")
  assert.equal(out![2], "you're after software roles — want me to go find some fits right now?", "composed closer is used")
  assert.equal(sawRoleLabel, "software engineering", "framing received the humanized role label")
})

test("framing SAFETY FALLBACK: keeps the locked template when the composer misses (null)", async () => {
  const { db } = makeStubDb({
    displayName: "Adam Yang",
    evidenceAskedAt: "2026-06-03T00:00:00Z",
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme", targetRoleFunction: ["software_engineering"] },
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }],
  })
  const pitch: PitchComposer = { async compose() { return "PITCH" } }
  const framing: TurnFramingComposer = { async composeFraming() { return null } }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", pitch, framing)
  assert.match(out![2]!, /^targeting software engineering roles — that right\? 👍 /, "reverts to the locked single-ask template")
})

test("framing is NOT used for the thin-evidence ask (the intentional either/or share-or-pull copy stays)", async () => {
  const { db } = makeStubDb({
    displayName: "Adam Yang",
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme" }, // thin + not-yet-asked → askForEvidence
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }],
  })
  const pitch: PitchComposer = { async compose() { return "PITCH" } }
  let called = false
  const framing: TurnFramingComposer = {
    async composeFraming() { called = true; return { confirmation: "x", closer: "want me to pull roles now?" } },
  }
  const out = await composePitchTurn(db, "u1", "2026-06-04T00:00:00Z", pitch, framing)
  assert.equal(called, false, "framing must NOT run on the thin-evidence either/or ask")
  assert.match(out![2]!, /i already know about you/, "thin-evidence copy preserved")
})

test("isValidComposedCloser: accepts a single clear pull-ask, rejects either/or + missing ask", () => {
  assert.equal(isValidComposedCloser("want me to go find some roles for you right now?"), true)
  assert.equal(isValidComposedCloser("you're after backend roles — should i pull a few matches now?"), true)
  // either/or makes a bare "sure" ambiguous → rejected (the Adam lock)
  assert.equal(isValidComposedCloser("want me to pull roles now or tweak your profile first?"), false)
  // no clear ask / no trailing "?" → rejected
  assert.equal(isValidComposedCloser("sounds great, talk soon"), false)
  assert.equal(isValidComposedCloser("want me to pull roles now"), false)
})

test("isValidComposedConfirmation: rejects a competing question and overlong text", () => {
  assert.equal(isValidComposedConfirmation("ok, just read your résumé 🙌"), true)
  assert.equal(isValidComposedConfirmation("did you want me to read it?"), false) // a question belongs in the closer
  assert.equal(isValidComposedConfirmation("x".repeat(200)), false)
})

// ---------------------------------------------------------------------------
// Employer-history signals (Adam 2026-06-10) — buildPitchProfile carries the
// pre-computed derived signals so the composer leads with founder/selectivity/
// scope/big-tech proof deterministically. Strictly additive.
// ---------------------------------------------------------------------------

test("buildPitchProfile: attaches employerSignals from tags when present", () => {
  const profile = buildPitchProfile({
    displayName: "Adam Yang",
    tags: {
      recentRoleTitle: "Senior SWE",
      recentCompany: "Stripe",
      employerStages: ["series_b"],
      employerTags: ["big_tech", "yc_alumni"],
      hasBigTechBackground: true,
      employerGrowthTier: "growth",
      founderRole: true,
      scopeOfOwnership: { teamSize: 5, revenue: "$2M ARR" },
      selectivitySignals: ["Top 0.1% of 390K"],
    },
  })
  assert.ok(profile.employerSignals, "employerSignals carried onto the profile")
  assert.equal(profile.employerSignals!.founderRole, true)
  assert.equal(profile.employerSignals!.hasBigTechBackground, true)
  assert.equal(profile.employerSignals!.employerGrowthTier, "growth")
  assert.deepEqual(profile.employerSignals!.employerTags, ["big_tech", "yc_alumni"])
  assert.deepEqual(profile.employerSignals!.scopeOfOwnership, { teamSize: 5, revenue: "$2M ARR" })
  assert.deepEqual(profile.employerSignals!.selectivitySignals, ["Top 0.1% of 390K"])
})

test("buildPitchProfile: NO employerSignals key for legacy users (no derived tags)", () => {
  const profile = buildPitchProfile({
    displayName: "Adam Yang",
    tags: { recentRoleTitle: "Senior SWE", recentCompany: "Stripe", skills: [{ name: "python" }] },
  })
  assert.ok(!("employerSignals" in profile), "absent signals → key absent (legacy profile byte-identical)")
})

// ─── YC FOUNDER-MATCH ENTRY (Adam 2026-07-20 "换个口吻…不用推进"): the closer never pushes — it
// states the notify promise (in the pool; text here + email on match). Evidence ask suppressed. ───

test("YC entry: closer is the notify promise — never a pull-ask, never the evidence ask", async () => {
  const { db, writes } = makeStubDb({
    displayName: "Ada Lin",
    source: "yc_startup_school",
    tags: { recentRoleTitle: "Software Engineer", recentCompany: "Acme", targetRoleFunction: ["software_engineering"] },
    experienceHighlights: [{ title: "Software Engineer", company: "Acme" }], // thin → would be evidence-ask
  })
  const mock: PitchComposer = { async compose() { return "PITCH" } }
  const out = await composePitchTurn(db, "u1", "2026-07-20T00:00:00Z", mock)
  assert.notEqual(out, null)
  assert.equal(out!.length, 3, "still [confirmation, pitch, offer]")
  assert.equal(out![1], "PITCH", "the pitch bubble is unchanged")
  const offer = out![2]!
  assert.match(offer, /founder-match pool/)
  assert.match(offer, /text you right here/)
  assert.match(offer, /email/)
  assert.doesNotMatch(offer, /pull some roles that fit you right now/, "no pull push")
  assert.doesNotMatch(offer, /that right\?/, "no role soft-confirm push")
  assert.doesNotMatch(offer, /i already know about you/, "no evidence ask")
  assert.equal(
    writes.some((w) => typeof (w as { evidenceAskedAt?: unknown }).evidenceAskedAt === "string"),
    false,
    "no evidence-ask stamp for a yc entry",
  )
})
