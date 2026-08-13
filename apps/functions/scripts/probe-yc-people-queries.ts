/**
 * Probe the YC people matcher across a realistic query taxonomy, and print the actual NAMES.
 *
 * WHY A NAMED PRINTOUT: a score can improve while the same wrong people come back. The taxonomy
 * below is grounded in what YC Startup School attendees actually typed (pa-users.ycIntake +
 * pa-messages inbound, read 2026-07-25), plus the three gaps Adam named: funding stage,
 * hiring intent, investors.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... ; export PA_OPENAI_AGENT_API_KEY=...
 *   node --import tsx apps/functions/scripts/probe-yc-people-queries.ts [--limit 4] [--only <cat>]
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cosineSimilarity } from "@pa/job-rec"
import { runYcPeopleMatch, type YcPeopleMatchFilters } from "../src/yc-people-match.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")
const OpenAI = require("openai")

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
  ),
})
const db = admin.firestore()
const client = new OpenAI({ apiKey: process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY })

const embed = async (text: string) => {
  const r = await client.embeddings.create({ model: "text-embedding-3-small", input: text })
  return r.data[0].embedding as number[]
}

/** Real attendee with both intake answers + experience highlights (Proofcrate founder). */
const USER = process.env.PROBE_USER ?? "3d1TYXwutJuPZ8wlZEwE"

type Case = { cat: string; label: string; filters: YcPeopleMatchFilters }

export const CASES: Case[] = [
  // A. PERSON TYPE — the dominant real ask ("founders", "investors", "operators", "creatives").
  { cat: "person-type", label: "investors", filters: { query: "investors, VCs, angel investors" } },
  { cat: "person-type", label: "founders", filters: { query: "startup founders, people who started a company" } },
  { cat: "person-type", label: "operators", filters: { query: "operators at startups, people who run operations day to day" } },
  { cat: "person-type", label: "engineers to hire", filters: { query: "strong software engineers I could hire" } },
  { cat: "person-type", label: "creatives / designers", filters: { query: "creatives, designers, artists" } },
  { cat: "person-type", label: "students", filters: { query: "students, undergrads still in school" } },
  { cat: "person-type", label: "fellowship / accelerator runners", filters: { query: "people who run fellowships or accelerators, program directors" } },
  { cat: "person-type", label: "mentors / advisors", filters: { query: "senior mentors or advisors who could advise me" } },

  // B. FUNDING STAGE — Adam gap 1 ("startup series B 左右的").
  { cat: "funding-stage", label: "series B-ish", filters: { query: "people at startups around Series B" } },
  { cat: "funding-stage", label: "pre-seed / just started", filters: { query: "pre-seed founders who just started, no funding yet" } },
  { cat: "funding-stage", label: "late stage / big co", filters: { query: "people at large late stage companies or public companies" } },

  // C. HIRING INTENT — Adam gap 2 ("hiring company").
  { cat: "hiring", label: "companies hiring now", filters: { query: "companies that are hiring right now" } },
  { cat: "hiring", label: "internship this summer", filters: { query: "startups where I could intern this summer" } },
  { cat: "hiring", label: "technical cofounder", filters: { query: "technical cofounder, someone who can build the product" } },
  { cat: "hiring", label: "business/product cofounder", filters: { query: "business or product cofounder, go to market side" } },

  // D. DOMAIN — verbatim from real intake answers.
  { cat: "domain", label: "dev tools / infra", filters: { query: "infra founders and anyone doing dev tools" } },
  { cat: "domain", label: "edtech", filters: { query: "founders building in edtech" } },
  { cat: "domain", label: "AI agents", filters: { query: "people building AI agents" } },
  { cat: "domain", label: "robotics", filters: { query: "people building robotics" } },
  { cat: "domain", label: "consumer", filters: { query: "consumer founders, consumer apps" } },
  { cat: "domain", label: "healthcare", filters: { query: "healthcare or medical startups" } },
  { cat: "domain", label: "fintech", filters: { query: "fintech and payments" } },

  // E. GEOGRAPHY.
  { cat: "geo", label: "SF Bay Area", filters: { location: ["San Francisco"] } },
  { cat: "geo", label: "New York", filters: { location: ["New York"] } },

  // F. AFFINITY (relational).
  { cat: "affinity", label: "same school", filters: { sameSchool: true } },
  { cat: "affinity", label: "same company", filters: { sameCompany: true } },
  { cat: "affinity", label: "ex-Google", filters: { companies: ["Google"] } },

  // G. INTENT / SITUATION.
  { cat: "intent", label: "first customers", filters: { query: "people who would be my first customers, my target buyer" } },
  { cat: "intent", label: "built what I'm building", filters: { query: "someone who has already built what I'm building" } },
  { cat: "intent", label: "repeat founder", filters: { query: "repeat founders who have exited a company before" } },
]

async function main() {
  const limitIdx = process.argv.indexOf("--limit")
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : 4
  const onlyIdx = process.argv.indexOf("--only")
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1]! : null
  const cases = only ? CASES.filter((c) => c.cat.includes(only) || c.label.includes(only)) : CASES

  for (const c of cases) {
    const out = await runYcPeopleMatch(
      { userId: USER, limit, filters: c.filters },
      { db, embed, cosine: cosineSimilarity },
    )
    console.log(
      `\n[${c.cat}] ${c.label}  pool=${out.poolSize} facet=${out.facetMatched}${out.didRelax ? " RELAXED" : ""}${out.reason ? ` reason=${out.reason}` : ""}`,
    )
    for (const r of out.results) {
      console.log(
        `   ${r.score.toFixed(3)} ${r.relaxed ? "~" : " "} ${r.name ?? "?"} — ${r.title ?? "?"} @ ${r.company ?? "?"}${r.location ? ` (${r.location})` : ""}`,
      )
    }
  }
}
void main().then(() => process.exit(0))
