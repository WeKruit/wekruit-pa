/**
 * REAL-LLM probe for the capability-vs-circumstance judge rule.
 *
 * A stub judge cannot catch a prompt rule that over- or under-fires — that lesson cost a live
 * incident when a decline rule fired on weak-but-genuine attempts. So this runs the SHIPPED system
 * prompt against the real router with two opposite cases:
 *
 *   STRONG — clears both capability items; `sf_full_time` is simply unasked.
 *            EXPECT: not banked as a hard gap, raised as an open question instead.
 *   WEAK   — a marketing associate against a backend role.
 *            EXPECT: capability items STILL gapped. The rule must not make the judge soft.
 *
 * Read-only: no Firestore, no writes, no sends.
 */
import { readFileSync } from "node:fs"
import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgeUserText,
  EVAL_JUDGMENT_JSON_SCHEMA,
} from "../src/recruiter-submission-eval.js"
import { callWithFallback } from "@pa/pa-resume-parser"

const env = readFileSync(process.env.PA_ENV ?? ".env", "utf8")
const pick = (k: string) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? ""
const OPENAI = pick("PA_OPENAI_AGENT_API_KEY")
if (!OPENAI) throw new Error("PA_OPENAI_AGENT_API_KEY missing — a stubbed run proves nothing here")

const GROUPS = [
  {
    kind: "hard",
    heading: "Hard requirements",
    items: [
      { id: "five_years_programming", text: "At least 5 years of hands-on programming; formal work experience is not required" },
      { id: "two_of_four_stack", text: "Concrete implementation evidence in at least 2 of: Rust, Swift, TypeScript/Node.js backend, microservices" },
      { id: "sf_full_time", text: "Available for full-time, in-person work in San Francisco" },
    ],
  },
  { kind: "fit", heading: "Strong fit signals", items: [{ id: "messaging_telecom", text: "Messaging, SMS or telecommunications experience" }] },
  { kind: "bonus", heading: "Bonuses", items: [] },
  { kind: "anti", heading: "Anti-signals", items: [] },
]

const JOB = {
  title: "Backend Engineer",
  company: "Photon",
  descriptionMd:
    "Build high-concurrency backend systems for messaging, phone and SMS. Full-time, in-person in San Francisco.",
}

const CASES = [
  {
    label: "STRONG — capability met, availability simply unasked",
    expect: "sf_full_time NOT a hard gap; raised as an open question",
    candidate: {
      name: "Test Strong",
      currentRole: "Senior Backend Engineer",
      currentCompany: "Acme",
      yoe: "8",
      notes:
        "8 years building Rust and TypeScript/Node.js microservices. Owned a high-concurrency SMS routing service handling 40k messages/sec, including on-call and incident ownership.",
    },
  },
  {
    label: "WEAK — must STILL gap the capability items",
    expect: "capability items remain gapped; rule must not soften the judge",
    candidate: {
      name: "Test Weak",
      currentRole: "Marketing Associate",
      currentCompany: "Acme",
      yoe: "2",
      notes: "Two years running paid social campaigns and email marketing. No engineering background.",
    },
  },
]

async function main() {
  for (const c of CASES) {
    const userText = buildJudgeUserText({
      jobId: "photon-backend-engineer-high-concurrency",
      job: JOB as never,
      groups: GROUPS as never,
      candidate: c.candidate as never,
      ticks: {},
      submission: {},
      research: undefined,
    })
    const r = (await callWithFallback({
      apiKey: OPENAI,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userText,
      schemaName: "eval_judgment",
      schema: EVAL_JUDGMENT_JSON_SCHEMA,
      log: () => {},
    } as never)) as { rawJson: string }
    const j = JSON.parse(r.rawJson) as {
      verdict: string
      confidence: number
      checklist: { hard: { met: number; total: number; gaps: string[] } }
      reasons: string[]
    }
    const gappedSf = j.checklist.hard.gaps.some((g) => /in-person|full-time|san francisco/i.test(g))
    console.log(`\n=== ${c.label}`)
    console.log(`    expect: ${c.expect}`)
    console.log(`    verdict=${j.verdict} conf=${j.confidence} hard=${j.checklist.hard.met}/${j.checklist.hard.total}`)
    console.log(`    sf banked as a gap? ${gappedSf ? "YES  <-- rule NOT working" : "no   <-- rule working"}`)
    console.log(`    gaps: ${JSON.stringify(j.checklist.hard.gaps)}`)
    console.log(`    reasons: ${j.reasons.slice(0, 3).map((x) => x.slice(0, 110)).join("\n             ")}`)
  }
}

void main().then(() => process.exit(0))
