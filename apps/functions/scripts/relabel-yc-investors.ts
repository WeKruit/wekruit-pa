/**
 * Measure and repair `businessDescriptor.personType` for the investor-shaped slice of a cohort.
 *
 * WHY THIS EXISTS (live, 2026-07-25 YC Startup School). The single most-complained-about failure of
 * the event was "i asked for investors and none of these people are investors". Three separate
 * causes were root-caused; this script fixes the one that no ranking change can reach — THE LABELS
 * ARE WRONG.
 *
 * Measured over the 43 records in the 1159-person cohort whose CURRENT title or company carries an
 * investing signal (or that already carry an `investor` label), hand-labelled from title + company:
 * 24 are genuine investors, and the primary-slot facet found only 12 of them. Ten of the twelve
 * misses carried NO `investor` token at any slot, and NINE of those ten were labelled
 * `program_operator` or `student` — because the descriptor prompt said a "Fellow" runs a programme
 * and an internship makes you a student, with no carve-out for a fellowship or internship AT A FUND:
 *
 *     Pratyaksh Mishra  Intern @ Khosla Ventures                      student, engineer
 *     Zhen Liu          Fellow @ Comma Capital                        program_operator, researcher
 *     Phoebe Pan        Analyst @ Harvard Undergraduate VC Group      program_operator, student
 *     Luc Beck          Summer Analyst @ Construct Capital            (none)
 *
 * That is a systematic prompt bug, not noise, so the fix is upstream in DESCRIPTOR_SYSTEM (done) and
 * a targeted re-label here. NOT a re-label of all 1159 — the error is specific to fund roles, and
 * re-running a 1159-row LLM pass on a hunch is exactly what the brief forbade.
 *
 * SAFE BY CONSTRUCTION:
 *  - The regex only SELECTS candidates from our own stored company/title fields (data
 *    classification, never intent classification over user prose), and it never gates a match. A
 *    false positive ("Capital One", "Goldman Sachs") costs one nano call and comes back labelled
 *    correctly; that is why the net is deliberately loose.
 *  - Writes ONLY `businessDescriptor.personType` — the rest of the descriptor, and every embedding,
 *    are untouched. `personType` is a facet, not embedded text (`descriptorText` uses businessModel
 *    / domain / whatTheyBuild only), so no re-embed is needed.
 *  - `--apply` dumps every previous value to a rollback JSON first.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... ; export PA_OPENAI_AGENT_API_KEY=...
 *   node --import tsx apps/functions/scripts/relabel-yc-investors.ts [--apply] [--cohort X]
 */
import { writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { YC_COHORT_2026 } from "../src/yc-people-match.js"
import { buildDescriptorInput, describeBusiness } from "../src/yc-business-descriptor.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")

const RECORDS = "pa-external-candidate-records"
const CONCURRENCY = 8

/**
 * Candidate net over OUR OWN stored company/title strings. Loose on purpose: recall is what matters
 * here (a miss is a person we never re-check), precision costs one cheap nano call. Not applied to
 * anything a user typed.
 */
export const INVESTING_FIRM_SIGNAL =
  /\b(ventures?|capital|partners?|vc|fund|funds|angel|invest\w*|equity|holdings)\b/i

/** True when this record is worth re-describing: current-role firm signal, or an existing label. */
export function isInvestorCandidate(r: {
  currentTitle?: unknown
  currentCompany?: unknown
  personType?: readonly string[]
}): boolean {
  const t = typeof r.currentTitle === "string" ? r.currentTitle : ""
  const c = typeof r.currentCompany === "string" ? r.currentCompany : ""
  return (
    INVESTING_FIRM_SIGNAL.test(t) ||
    INVESTING_FIRM_SIGNAL.test(c) ||
    (r.personType ?? []).includes("investor")
  )
}

/**
 * HAND LABELS, from title + company only (never invented — every one of these strings is on the
 * record). The rule: an investor is someone whose CURRENT role is at a capital-deploying
 * organisation in a capacity that sources, evaluates or decides on investments. Excluded:
 * engineers/PMs/BDRs at a company that merely has "Capital"/"Partners" in its name, founders who
 * have raised, retail brokers, and prop-trading quant interns (not startup investing).
 *
 * `true` = a founder asking "who should I pitch?" would want this card.
 */
export const INVESTOR_TRUTH: Record<string, boolean> = {
  "Abigail Hsu | External Vice President @ Bruin Ventures": true,
  "Adam Rebei |  @ ": false, // no title, no company, no experience — the label came from nothing
  "Adam Siwek | Math + CS @ Rice University @ XTB online investing": false, // retail broker, student
  "Ahaan Shah | Software Engineer @ Michigan Investment Group": false, // engineer, not investing
  "Akshay Joshi | Analyst @ TreeLine Investment Management": true,
  "Alex Zhu | Fundamental Analyst @ Chengwei Capital": true,
  "Amy Lin | Co-founder & Managing Partner @ Outcast Ventures": true,
  "Ananya Zaverchand | Deal Sourcing & Startup Analysis Extern @ HP Tech Ventures": true,
  "Andrea Murillo Martinez | Calvin Shindo Student Venture Fund Co-Director Associate @ Pacific Asian Center for Entrepreneurship":
    true,
  "Arjun Rao | Venture Capital & AI Ethics @ 101 Fellowship": true,
  "Balaji Daggupati | Member of Investing Staff @ pebblebed": true,
  "Calvin Cha | Product & Growth @ Blidz": false,
  "Coco Hernandez | Investment Fellow @ 645 Ventures": true,
  "Cynthia Zhang | Board Observer @ StarCloud Technologies, LLC": true,
  "Cyrus Ghane | Venture Intern @ TQ Ventures": true,
  "Deniz Gursoy | Fellow @ Comma Capital": true,
  "Eric Xiao | Council Member @ Laxis": false,
  "Ethan Chen | Business Development Representative @ CalDigit": false,
  "Evangeline Juliet John Francis Kennedy | Shareholder Partner @ Stagwell": false, // marketing agency
  "Hamzah Azzam | VC Analyst @ Idea Fund of La Crosse": true,
  "Harry Song | Intern @ Vision Knight Capital": true,
  "Ishani Bakshi | VP of Content @ Girls Into VC": false, // community/education org, not a fund
  "Jack Lau | Co-Founder @ Stealth AI Startup": false,
  "James Unsworth | Equity Cross Product Engineering @ Goldman Sachs": false,
  "Jason Liu | Developer Experience Engineer @ OpenAI": false,
  "Jaxon Poentis | Software Engineer Intern @ Capital One": false,
  "Krish Chopra | Co-Founder, Partner @ NPHub": false,
  "Luc Beck | Summer Analyst @ Construct Capital": true,
  "Penelope Pressman | Capital & Growth Ops @ RSTRNT Pass": false,
  "Phoebe Pan | Analyst @ Harvard Undergraduate Venture Capital Group": true,
  "Pratyaksh Mishra | Intern @ Khosla Ventures": true,
  "Raghav Goyal | Consumer Tech Investor @ Antler": true,
  "Richard Liu | Investor @ Llama Ventures": true,
  "Ruhan Gupta | Co-Founder @ InvestInEcon": false, // financial-literacy education, not a fund
  "Ryan Schwartz | Co-Founder @ Stealth": false,
  "Samuel Kim | Managing Partner @ Hico Ventures": true,
  "Sneha Sharma | Client Growth Partner @ Futurism Technologies, INC.": false,
  "Sonica Prakash | Investor @ Crater Ventures": true,
  "Teresa Huang | Product Manager @ DataVisor": false,
  "Tobasum Mandal | Community Lead @ G2C Ventures": true, // VC diligence per own profile
  "Vikram Kakaria | Incoming Quantitative Researcher Intern @ Tower Research Capital": false, // prop trading
  "William Carr | Vice President @ Gayner Family Sustainable Investment Fund @ UVA": true,
  "Zhen Liu | Fellow @ Comma Capital": true,
}

export function truthKey(r: { name?: unknown; currentTitle?: unknown; currentCompany?: unknown }): string {
  return `${r.name ?? ""} | ${r.currentTitle ?? ""} @ ${r.currentCompany ?? ""}`
}

/** precision / recall / F1 of a predicate against the hand labels. */
export function score(
  rows: Array<{ key: string; predicted: boolean }>,
): { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number } {
  let tp = 0
  let fp = 0
  let fn = 0
  for (const r of rows) {
    const truth = INVESTOR_TRUTH[r.key]
    if (truth === undefined) continue
    if (r.predicted && truth) tp++
    else if (r.predicted && !truth) fp++
    else if (!r.predicted && truth) fn++
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  }
}

function row(label: string, s: ReturnType<typeof score>): string {
  const p = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6)
  return `${label.padEnd(34)} tp=${String(s.tp).padStart(2)} fp=${String(s.fp).padStart(2)} fn=${String(
    s.fn,
  ).padStart(2)}   P ${p(s.precision)}   R ${p(s.recall)}   F1 ${s.f1.toFixed(3)}`
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const cohortArg = process.argv.indexOf("--cohort")
  const cohort = cohortArg > -1 ? String(process.argv[cohortArg + 1]) : YC_COHORT_2026
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? ""
  if (!apiKey) throw new Error("PA_OPENAI_AGENT_API_KEY required")

  if (!admin.apps.length) admin.initializeApp()
  const db = admin.firestore()

  const snap = await db.collection(RECORDS).where("enrichment.cohort", "==", cohort).get()
  const cands = snap.docs
    .map((d: { id: string; data: () => Record<string, unknown> }) => {
      const x = d.data()
      return {
        id: d.id,
        raw: x,
        key: truthKey(x),
        personType: ((x.businessDescriptor as { personType?: string[] } | undefined)?.personType ??
          []) as string[],
      }
    })
    .filter((r: { raw: Record<string, unknown>; personType: string[] }) =>
      isInvestorCandidate({
        currentTitle: r.raw.currentTitle,
        currentCompany: r.raw.currentCompany,
        personType: r.personType,
      }),
    )

  console.log(`cohort=${cohort} pool=${snap.size} investor-shaped candidates=${cands.length}`)
  console.log(`hand-labelled truth set: ${Object.keys(INVESTOR_TRUTH).length} (${
    Object.values(INVESTOR_TRUTH).filter(Boolean).length
  } true investors)\n`)

  type C = (typeof cands)[number]
  const before = cands.map((c: C) => ({ key: c.key, predicted: c.personType[0] === "investor" }))
  const beforeAny = cands.map((c: C) => ({ key: c.key, predicted: c.personType.includes("investor") }))
  const beforeTop2 = cands.map((c: C) => ({
    key: c.key,
    predicted: c.personType.slice(0, 2).includes("investor"),
  }))

  console.log("BEFORE (current stored labels)")
  console.log(row("  slot 0 only (shipped)", score(before)))
  console.log(row("  slot 0 or slot 1", score(beforeTop2)))
  console.log(row("  any slot (the old bug)", score(beforeAny)))

  // Re-describe every candidate with the corrected prompt.
  const results: Array<{ id: string; key: string; from: string[]; to: string[] }> = []
  let cursor = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const i = cursor++
        if (i >= cands.length) return
        const c = cands[i] as C
        try {
          const d = await describeBusiness(buildDescriptorInput(c.raw), apiKey)
          results.push({ id: c.id, key: c.key, from: c.personType, to: d.personType })
        } catch (e) {
          console.error(`  FAIL ${c.key}: ${e instanceof Error ? e.message : String(e)}`)
          results.push({ id: c.id, key: c.key, from: c.personType, to: c.personType })
        }
      }
    }),
  )

  const after = results.map((r) => ({ key: r.key, predicted: r.to[0] === "investor" }))
  console.log("\nAFTER (corrected prompt, re-described)")
  console.log(row("  slot 0 only", score(after)))

  console.log("\nCHANGES")
  for (const r of results.sort((a, b) => a.key.localeCompare(b.key))) {
    const was = r.from[0] === "investor"
    const now = r.to[0] === "investor"
    if (was === now && JSON.stringify(r.from) === JSON.stringify(r.to)) continue
    const truth = INVESTOR_TRUTH[r.key]
    const mark = now === truth ? "ok " : truth === undefined ? "?  " : "BAD"
    console.log(`  ${mark} ${r.key}\n        ${JSON.stringify(r.from)} -> ${JSON.stringify(r.to)}`)
  }

  if (!apply) {
    console.log("\nDRY RUN — pass --apply to write personType (and only personType).")
    return
  }
  const rollback = `/tmp/yc-investor-relabel-rollback-${Date.now()}.json`
  writeFileSync(rollback, JSON.stringify(results.map((r) => ({ id: r.id, personType: r.from })), null, 1))
  console.log(`\nrollback written: ${rollback}`)
  let written = 0
  for (const r of results) {
    if (JSON.stringify(r.from) === JSON.stringify(r.to)) continue
    await db
      .collection(RECORDS)
      .doc(r.id)
      .set({ businessDescriptor: { personType: r.to } }, { merge: true })
    written++
  }
  console.log(`applied: ${written} records`)
}

if (process.argv[1]?.includes("relabel-yc-investors")) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e)
      process.exit(1)
    },
  )
}
