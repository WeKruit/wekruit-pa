/**
 * Derive a business descriptor for every attendee in a cohort and cache it on the record.
 *
 * WHY: a LinkedIn profile says "Software Engineer @ Faire", never "two-sided marketplace".
 * Concrete-domain queries ("robotics") match verbatim text; business-MODEL queries
 * ("marketplace", "B2B SaaS", "vertical SaaS") have nothing to bind to, so they rank noise
 * (measured: top hit for "marketplace" was a web agency, cosine 0.31). Company → business model
 * is world knowledge the LLM has and the profile does not state, so we materialise it at index
 * time and fold it into the embedded text (`synthesizePeopleMatchText({ businessDescriptor })`).
 *
 * Cheap tier only (`callWithFallback` → gpt-5.4-nano first), once per record, cached on
 * `businessDescriptor`. Re-embed afterwards with `embed-yc-attendees.ts --refresh`.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... ; export PA_OPENAI_AGENT_API_KEY=...
 *   node --import tsx apps/functions/scripts/describe-yc-attendees.ts <cohort> [--apply] [--limit N]
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { callWithFallback } from "@pa/pa-resume-parser"
import { YC_COHORT_2026, type BusinessDescriptor } from "../src/yc-people-match.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")

const CONCURRENCY = 8
const RECORDS = "pa-external-candidate-records"

const SYSTEM = `You label a person's professional profile with WHAT THE COMPANIES THEY WORK(ED) AT ACTUALLY DO.

You are given titles, companies and experience blurbs. Use your own knowledge of the named companies — the profile itself almost never states the business model, and that is exactly the gap you are filling.

businessModel: the company's model, lowercase, from this vocabulary where it fits:
  marketplace, two_sided_marketplace, b2b_saas, vertical_saas, enterprise_software, consumer_app,
  consumer_social, consumer_subscription, ecommerce, dtc_brand, fintech, payments, insurtech,
  developer_tools, infrastructure, cloud_platform, ai_foundation_model, ai_application, hardware,
  robotics, semiconductors, biotech, medical_device, healthcare_provider, edtech, govtech, defense,
  agency_consulting, staffing, research_lab, university, nonprofit, media, gaming, adtech, logistics,
  real_estate, proptech, climate, energy, agtech, legaltech, hrtech, cybersecurity, open_source.
  Add a term outside the list only when none fits. 1-3 entries, most specific first.

domain: the industry/problem space in plain words (e.g. "logistics", "clinical care", "consumer finance",
  "developer productivity"). 1-3 entries.

whatTheyBuild: ONE sentence, max 25 words, naming the product category AND who buys it —
  e.g. "freight matching platform connecting shippers and carriers" or
  "subscription billing software sold to B2B SaaS finance teams".

Weight the CURRENT role most. If a company is unknown to you, infer conservatively from the title and
blurb rather than inventing a product. Students/interns with no company: describe the field they work in.`

type Row = { id: string; text: string }

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** The profile text nano sees — companies are the load-bearing part. */
export function buildDescriptorInput(d: Record<string, unknown>): string {
  const exp = (Array.isArray(d.experience) ? d.experience : []) as Array<Record<string, unknown>>
  const lines: string[] = []
  const cur = [s(d.currentTitle), s(d.currentCompany)].filter(Boolean).join(" @ ")
  if (cur) lines.push(`Current: ${cur}`)
  for (const e of exp.slice(0, 6)) {
    const head = [s(e.title), s(e.company)].filter(Boolean).join(" @ ")
    const desc = s(e.description).slice(0, 300)
    if (!head && !desc) continue
    lines.push(desc ? `- ${head}: ${desc}` : `- ${head}`)
  }
  const tags = (Array.isArray(d.sourceTags) ? d.sourceTags : []).filter((x) => typeof x === "string")
  if (tags.length) lines.push(`Skills: ${tags.slice(0, 15).join(", ")}`)
  return lines.join("\n").slice(0, 4000)
}

const SCHEMA = {
  type: "object",
  properties: {
    businessModel: { type: "array", items: { type: "string" } },
    domain: { type: "array", items: { type: "string" } },
    whatTheyBuild: { type: "string" },
  },
  required: ["businessModel", "domain", "whatTheyBuild"],
  additionalProperties: false,
} as const

async function describe(text: string, apiKey: string): Promise<BusinessDescriptor> {
  const res = await callWithFallback({
    apiKey,
    systemPrompt: SYSTEM,
    userText: text,
    schemaName: "business_descriptor",
    schema: SCHEMA as unknown as Record<string, unknown>,
  })
  const p = JSON.parse(res.rawJson) as Partial<BusinessDescriptor>
  const arr = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim())
      .slice(0, 3)
  return {
    businessModel: arr(p.businessModel),
    domain: arr(p.domain),
    whatTheyBuild: s(p.whatTheyBuild).slice(0, 250),
  }
}

async function main() {
  const cohort = process.argv[2] ?? YC_COHORT_2026
  const apply = process.argv.includes("--apply")
  const limitIdx = process.argv.indexOf("--limit")
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error("OPENAI key missing")
    process.exit(2)
  }

  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
    ),
  })
  const db = admin.firestore()

  const snap = await db.collection(RECORDS).where("enrichment.cohort", "==", cohort).get()
  const todo: Row[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    if (d.coresignalMatch !== "ok") continue
    if (d.businessDescriptor) continue
    const text = buildDescriptorInput(d)
    if (text.length < 20) continue
    todo.push({ id: doc.id, text })
  }
  const work = todo.slice(0, limit === Infinity ? todo.length : limit)
  console.log(`[yc-describe] cohort=${cohort} records=${snap.size} needDescriptor=${todo.length} doing=${work.length}`)
  if (!apply) {
    console.log("[yc-describe] DRY RUN — pass --apply")
    console.log(work[0]?.text)
    return
  }

  let done = 0
  let failed = 0
  const now = new Date().toISOString()
  let cursor = 0
  const worker = async () => {
    while (cursor < work.length) {
      const row = work[cursor++]!
      try {
        const descriptor = await describe(row.text, apiKey)
        await db.collection(RECORDS).doc(row.id).set(
          { businessDescriptor: { ...descriptor, generatedAt: now } },
          { merge: true },
        )
        done++
      } catch (err) {
        failed++
        console.error(`[yc-describe] fail ${row.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if ((done + failed) % 25 === 0) console.log(`[yc-describe] ${done + failed}/${work.length} (failed=${failed})`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log(`[yc-describe] DONE ok=${done} failed=${failed}`)
}

void main().then(() => process.exit(0))
