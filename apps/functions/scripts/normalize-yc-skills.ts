/**
 * normalize-yc-skills.ts — make the YC-cohort `skills` facet usable.
 *
 * WHY: `sourceTags` on these records is Coresignal `inferred_skills` verbatim (`historical_skills`
 * is empty for every attendee we sampled — LinkedIn's curated list simply isn't in the payload).
 * Inferred skills are LLM-scraped off profile text, so they are long (median 62/person, max 415)
 * and full of noise: "across", "ases", "led", "incoming", "c". That noise is *actively harmful*
 * because `yc-people-match.ts:187 looseHit()` is bidirectional substring — a member carrying the
 * token "c" matches ANY query containing the letter c, and "ai" matches "email", "training", …
 *
 * WHAT: writes a cleaned `normalizedSkills: string[]` alongside (never over) `sourceTags`.
 * `sourceTags` is raw provenance and is read as skills by legacy-user-tags-bridge.ts and
 * coresignal-experiences-mirror.ts, so it stays byte-identical.
 *
 * FORM: space-separated lowercase phrases ("machine learning"), NOT the underscore canon.
 * Deliberate — the consumer is `looseHit`'s substring test, so `machine_learning` would fail a
 * "machine learning" query. Canonicalization still happens internally (via the shipped
 * `canonicalizeSkillName`, which expands ml/ai/js/k8s → spelled-out) purely for dedupe.
 *
 * Deterministic, no LLM: rules + the shipped `inferSkillBucket` vocabulary, so a re-run is free
 * and reproducible.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=...
 *   node --import tsx apps/functions/scripts/normalize-yc-skills.ts [--apply] [--cohort X]
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { inferSkillBucket } from "@pa/pa-orchestrator"
// Shared with the matcher's facet stage — query and storage MUST canonicalize identically.
import { normalizeSkillToken } from "../src/skill-token.js"

const require = createRequire(import.meta.url)
const admin = require("firebase-admin")

const RECORDS = "pa-external-candidate-records"
const DEFAULT_COHORT = "yc_startup_school_2026"

/**
 * Document-frequency ceiling. A token carried by >=30% of a 1000-person cohort cannot narrow that
 * cohort, so it is dropped UNLESS it is real technical vocabulary (see `isTechnical`) — "machine
 * learning" at 40% is still the answer to "who else does ML", "research" at 59% is not.
 */
const DF_CEILING = 0.3

/**
 * Document-frequency FLOOR. Coresignal's inferred skills have a 10k-token singleton tail —
 * "spanning cloud apps", "solve complex problems", "ases" — that no denylist can ever enumerate.
 * A token exactly one person in the cohort carries cannot connect two people, which is the only
 * thing this facet does, so requiring df>=2 deletes the tail without deleting signal.
 * Text-derived backfill tokens are exempt: they already had to clear a real vocabulary.
 */
const MIN_DF = 2

/** Buckets that count as matchable signal. `soft_skills` is a bucket but never discriminative. */


/**
 * Technical terms the shipped `inferSkillBucket` heuristics don't cover. Only exists to rescue
 * high-df-but-meaningful tokens from DF_CEILING — everything else survives without being listed.
 */


/** Person-nouns: a token ending in one of these is a JOB TITLE, not a skill. */


/**
 * Generic words that survive every shape rule but carry no matching signal. Built by reading the
 * actual top-320 tokens of this cohort — stopwords ("across", "per"), bare verbs ("led",
 * "analyzing"), and business nouns ("operations", "strategy") that describe everyone.
 */


/** Variant collapse. Left side is post-canonicalization. */


/**
 * Short tokens worth keeping despite the <4-char rule. That rule exists because `looseHit` is a
 * bidirectional substring test, so a 1-3 char token is a false-positive machine: a member carrying
 * "c" matches every query containing the letter c, and "chi" matches the query "machine learning".
 */




/**
 * raw Coresignal token → canonical underscore form, or null when it is noise.
 * Shape rules only; the cohort-wide frequency gates (MIN_DF / DF_CEILING) are applied by the
 * caller once every record has been canonicalized.
 */

export function skillsFromText(texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>()
  for (const t of texts) {
    if (!t) continue
    const words = t.toLowerCase().replace(/[^a-z0-9+#.\s-]/g, " ").split(/\s+/).filter(Boolean)
    for (let i = 0; i < words.length; i++) {
      for (let n = 3; n >= 1; n--) {
        if (i + n > words.length) continue
        const phrase = words.slice(i, i + n).join(" ")
        const canon = normalizeSkillToken(phrase)
        // Text is noisy prose: only accept tokens a real vocabulary recognizes.
        if (canon && isTechnical(canon)) out.add(canon)
      }
    }
  }
  return [...out]
}

type Rec = Record<string, unknown>
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []

function expText(d: Rec): string[] {
  const exp = (Array.isArray(d.experience) ? d.experience : []) as Rec[]
  return exp.flatMap((e) => [typeof e.title === "string" ? e.title : null, typeof e.description === "string" ? e.description : null])
    .filter((x): x is string => Boolean(x))
}

/** Simulates yc-people-match.ts looseHit() so the report shows real facet breadth, not a proxy. */
function facetHits(pool: string[][], needle: string): number {
  const q = needle.toLowerCase()
  return pool.filter((skills) => skills.some((h) => h.includes(q) || q.includes(h))).length
}

function pct(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.floor(q * (sorted.length - 1))]! : 0
}

/** `--selftest` — runs without Firestore. The one check that fails if the rules regress. */
function selftest() {
  const eq = (got: unknown, want: unknown, what: string) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  }
  eq(normalizeSkillToken("Python (Programming Language)"), "python", "parenthetical stripped")
  eq(normalizeSkillToken("AI (Artificial Intelligence)"), "artificial_intelligence", "abbrev expanded")
  eq(normalizeSkillToken("Artificial Intelligence (AI)"), "artificial_intelligence", "variant converges")
  eq(normalizeSkillToken("AI/ML"), "machine_learning", "alias")
  eq(normalizeSkillToken("Full-Stack Development"), "full_stack_development", "hyphen → underscore")
  eq(normalizeSkillToken("c"), null, "1-char token dropped")
  eq(normalizeSkillToken("across"), null, "stopword dropped")
  eq(normalizeSkillToken("analyzing"), null, "bare gerund dropped")
  eq(normalizeSkillToken("Research Assistant"), null, "job title dropped")
  eq(normalizeSkillToken("led"), null, "bare verb dropped")
  eq(normalizeSkillToken("C++"), "c++", "short whitelist kept")
  eq(normalizeSkillToken("Machine Learning"), "machine_learning", "real skill kept")
  if (!isTechnical("machine_learning")) throw new Error("ML must be technical (survives DF ceiling)")
  if (isTechnical("leadership")) throw new Error("soft skills must not survive DF ceiling")
  const derived = skillsFromText(["Software Engineer @ Vercel building React tooling in TypeScript"])
  for (const want of ["react", "typescript"]) {
    if (!derived.includes(want)) throw new Error(`text extraction missed ${want}: ${derived.join(",")}`)
  }
  console.log("[selftest] ok")
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest()
  const apply = process.argv.includes("--apply")
  const cohortArg = process.argv.indexOf("--cohort")
  const cohort = cohortArg > 0 ? process.argv[cohortArg + 1]! : DEFAULT_COHORT

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
  })
  const db = admin.firestore()

  const snap = await db.collection(RECORDS).where("enrichment.cohort", "==", cohort).get()
  const docs = snap.docs.map((d: { id: string; data: () => Rec }) => ({ id: d.id, d: d.data() }))
  console.log(`[yc-skills] cohort=${cohort} records=${docs.length} apply=${apply}`)

  // ---- measure: BEFORE -----------------------------------------------------
  const before: string[][] = docs.map((r: { d: Rec }) => strArr(r.d.sourceTags))
  const beforeCounts = before.map((s: string[]) => s.length).sort((a: number, b: number) => a - b)
  const df = new Map<string, number>()
  for (const skills of before) {
    for (const t of new Set(skills.map((x: string) => x.toLowerCase().trim()))) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const n = docs.length
  console.log(
    `[before] zeroSkill=${beforeCounts.filter((c: number) => c === 0).length} ` +
      `p25=${pct(beforeCounts, 0.25)} p50=${pct(beforeCounts, 0.5)} p75=${pct(beforeCounts, 0.75)} ` +
      `p90=${pct(beforeCounts, 0.9)} max=${beforeCounts[beforeCounts.length - 1]} distinctTokens=${df.size}`,
  )
  console.log(
    "[before] top junk (df>=25%):",
    [...df.entries()].filter(([, c]) => c / n >= 0.25).sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}(${((c / n) * 100) | 0}%)`).join(" "),
  )

  // ---- pass 1: shape-normalize, then measure CANONICAL document frequency ---
  const canonSets: Array<Set<string>> = docs.map(({ d }: { d: Rec }) => {
    const kept = new Set<string>()
    for (const t of strArr(d.sourceTags)) {
      const canon = normalizeSkillToken(t)
      if (canon) kept.add(canon)
    }
    return kept
  })
  const canonDf = new Map<string, number>()
  for (const s of canonSets) for (const c of s) canonDf.set(c, (canonDf.get(c) ?? 0) + 1)

  // ---- pass 2: apply frequency gates, backfill the empties from text --------
  let backfilled = 0
  const after: string[][] = canonSets.map((set, i) => {
    const kept = new Set<string>()
    for (const c of set) {
      const freq = canonDf.get(c) ?? 0
      if (freq < MIN_DF) continue
      if (freq / n >= DF_CEILING && !isTechnical(c)) continue
      kept.add(c)
    }
    if (kept.size === 0) {
      const d = docs[i]!.d
      const derived = skillsFromText([
        typeof d.currentTitle === "string" ? d.currentTitle : null,
        ...expText(d),
      ])
      if (derived.length) backfilled++
      for (const c of derived) kept.add(c)
    }
    return [...kept].map(display).sort()
  })

  const afterCounts = after.map((s) => s.length).sort((a, b) => a - b)
  const afterDistinct = new Set(after.flat())
  console.log(
    `[after]  zeroSkill=${afterCounts.filter((c) => c === 0).length} ` +
      `p25=${pct(afterCounts, 0.25)} p50=${pct(afterCounts, 0.5)} p75=${pct(afterCounts, 0.75)} ` +
      `p90=${pct(afterCounts, 0.9)} max=${afterCounts[afterCounts.length - 1]} distinctTokens=${afterDistinct.size} ` +
      `textBackfilled=${backfilled}`,
  )
  const singles = [...afterDistinct].filter((t) => !t.includes(" "))
  const singleDf = singles
    .map((t) => [t, after.filter((s) => s.includes(t)).length] as const)
    .sort((a, b) => b[1] - a[1])
  console.log(`[after] surviving single-word tokens (top 60 of ${singles.length}, audit for junk):`)
  console.log("  " + singleDf.slice(0, 60).map(([t, c]) => `${t}:${c}`).join(" "))
  for (const probe of ["machine learning", "fintech", "robotics", "python", "design"]) {
    const b = facetHits(before.map((s: string[]) => s.map((x: string) => x.toLowerCase())), probe)
    console.log(`[facet] "${probe}": before=${b}/${n} after=${facetHits(after, probe)}/${n}`)
  }

  // ---- samples -------------------------------------------------------------
  const fat = docs.map((_: unknown, i: number) => i).sort((a: number, b: number) => before[b]!.length - before[a]!.length)
  const samples = [...fat.slice(0, 2), ...docs.map((_: unknown, i: number) => i).filter((i: number) => before[i]!.length === 0).slice(0, 2)]
  for (const i of samples) {
    const { d } = docs[i]!
    console.log(`\n--- ${String(d.name)} | ${String(d.currentTitle ?? "-")} @ ${String(d.currentCompany ?? "-")}`)
    console.log(`  BEFORE (${before[i]!.length}): ${before[i]!.slice(0, 30).join(", ")}${before[i]!.length > 30 ? " …" : ""}`)
    console.log(`  AFTER  (${after[i]!.length}): ${after[i]!.join(", ")}`)
  }

  if (!apply) {
    console.log("\n[yc-skills] DRY RUN — pass --apply to write normalizedSkills")
    return
  }

  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch()
    const end = Math.min(i + 400, docs.length)
    for (let j = i; j < end; j++) {
      batch.set(db.collection(RECORDS).doc(docs[j]!.id), { normalizedSkills: after[j] }, { merge: true })
    }
    await batch.commit()
    console.log(`[yc-skills] wrote ${end}/${docs.length}`)
  }
}

// Only run when executed directly — `normalizeSkillToken` / `skillsFromText` are importable so the
// query side can normalize a facet the same way the stored data was normalized.
if (process.argv[1]?.endsWith("normalize-yc-skills.ts")) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e)
      process.exit(1)
    },
  )
}
