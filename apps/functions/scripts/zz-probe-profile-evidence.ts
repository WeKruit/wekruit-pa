/**
 * REAL-LLM probe for the WeKruit-profile evidence block.
 *
 * A stub judge proves only that the string is in the prompt. The question that matters is whether
 * the model TREATS it as primary evidence — three prompt-only rules have failed under fire this
 * week, so this runs the SHIPPED prompt against the real router on three cases:
 *
 *   A. SAME candidate, NO profile   → the status quo. Hard items should be gaps ("unverifiable").
 *   B. SAME candidate, WITH profile → the fix. The same hard items must now be MET.
 *   C. WEAK candidate, WITH profile → the control. A profile that does not support the
 *      requirements must STILL gap them; the block must not become a free pass.
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
      { id: "five_years", text: "At least 5 years of hands-on programming; formal work experience is not required" },
      { id: "two_of_four", text: "Concrete implementation evidence in at least 2 of: Rust, Swift, TypeScript/Node.js backend, microservices" },
      { id: "ownership", text: "Can explain personal ownership of a high-concurrency, distributed, messaging, or reliability-critical backend system" },
    ],
  },
  { kind: "fit", heading: "Strong fit signals", items: [{ id: "messaging", text: "Messaging, SMS or telecommunications experience" }] },
  { kind: "bonus", heading: "Bonuses", items: [] },
  { kind: "anti", heading: "Anti-signals", items: [] },
]
const JOB = {
  title: "Backend Engineer",
  company: "Photon",
  descriptionMd: "Build high-concurrency backend systems for messaging, phone and SMS.",
}
// Modelled on a real cohort member: strong profile, no résumé, thin recruiter notes.
const CANDIDATE = { name: "Test Strong", currentRole: "Senior Software Engineer", currentCompany: "Microsoft", yoe: "8.2", notes: "From the YC Startup School cohort." }
const STRONG_PROFILE = {
  displayName: "Test Strong",
  recentRoleTitle: "Senior Software Engineer - Office of the CTO",
  recentCompany: "Microsoft",
  workHistorySummary: "Senior SWE, Office of the CTO @ Microsoft; SWE II, Mixed Reality Cloud @ Microsoft",
  experience: [
    { title: "Senior Software Engineer - Office of the CTO", company: "Microsoft", dates: "2021–now", description: "Rust and TypeScript services; owned a distributed microservice mesh handling high-concurrency device telemetry, including on-call and incident response." },
    { title: "Software Engineer II - Mixed Reality Cloud", company: "Microsoft", dates: "2018–2021", description: "Golang backend microservices for real-time session routing at scale." },
  ],
  building: undefined,
}
const WEAK_PROFILE = {
  displayName: "Test Weak",
  recentRoleTitle: "Marketing Associate",
  recentCompany: "Acme",
  workHistorySummary: "Marketing Associate @ Acme",
  experience: [{ title: "Marketing Associate", company: "Acme", dates: "2024–now", description: "Ran paid social campaigns and email marketing. No engineering work." }],
  building: undefined,
}

const CASES = [
  { label: "A. strong candidate, NO profile  (status quo)", expect: "hard items GAPPED for lack of evidence", candidate: CANDIDATE, profile: undefined },
  { label: "B. strong candidate, WITH profile (the fix)", expect: "the SAME hard items now MET", candidate: CANDIDATE, profile: STRONG_PROFILE },
  { label: "C. weak candidate, WITH profile   (control)", expect: "hard items STILL gapped — no free pass", candidate: { name: "Test Weak", currentRole: "Marketing Associate", currentCompany: "Acme", yoe: "2", notes: "From the cohort." }, profile: WEAK_PROFILE },
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
      wekruitProfile: c.profile as never,
    })
    const r = (await callWithFallback({
      apiKey: OPENAI, systemPrompt: JUDGE_SYSTEM_PROMPT, userText,
      schemaName: "eval_judgment", schema: EVAL_JUDGMENT_JSON_SCHEMA, log: () => {},
    } as never)) as { rawJson: string }
    const j = JSON.parse(r.rawJson) as {
      verdict: string; confidence: number
      checklist: { hard: { met: number; total: number; gaps: string[] } }
      reasons: string[]
    }
    console.log(`\n=== ${c.label}`)
    console.log(`    expect : ${c.expect}`)
    console.log(`    RESULT : verdict=${j.verdict} conf=${j.confidence} hard=${j.checklist.hard.met}/${j.checklist.hard.total}`)
    console.log(`    gaps   : ${JSON.stringify(j.checklist.hard.gaps.map((g) => g.slice(0, 55)))}`)
    console.log(`    reason : ${(j.reasons[0] ?? "").slice(0, 160)}`)
  }
}
void main().then(() => process.exit(0))
