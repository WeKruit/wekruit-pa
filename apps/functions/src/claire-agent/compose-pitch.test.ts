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
  type PitchComposer,
} from "./compose-pitch.js"

/**
 * A tiny in-memory Firestore stub good enough for composePitchTurn: a single pa-users doc + an empty
 * parsedCandidateResumes query, and it records set(merge:true) writes so we can assert the once-only
 * evidenceAskedAt stamp.
 */
function makeStubDb(userDoc: Record<string, unknown>) {
  const writes: Record<string, unknown>[] = []
  const db = {
    collection(name: string) {
      if (name === "parsedCandidateResumes") {
        return { where: () => ({ async get() { return { empty: true, docs: [] } } }) }
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
