/**
 * REAL-LLM probe: does role ORDER change the verdict?
 *
 * Uses the verbatim stored shape of a real candidate — Microsoft, Office of the CTO — whose
 * `experienceHighlights` is oldest-first, capped at 10, and does not contain her current role at
 * all. Live eval scored her 2/4 reasoning "largely internships". Same person, two renderings.
 */
import { readFileSync } from "node:fs"
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserText, EVAL_JUDGMENT_JSON_SCHEMA } from "../src/recruiter-submission-eval.js"
import { callWithFallback } from "@pa/pa-resume-parser"

const env = readFileSync(process.env.PA_ENV ?? ".env", "utf8")
const OPENAI = env.match(/^PA_OPENAI_AGENT_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? ""
if (!OPENAI) throw new Error("PA_OPENAI_AGENT_API_KEY missing")

const GROUPS = [
  { kind: "hard", heading: "Hard", items: [
    { id: "five_years", text: "At least 5 years of hands-on programming; formal work experience is not required" },
    { id: "two_of_four", text: "Concrete implementation evidence in at least 2 of: Rust, Swift, TypeScript/Node.js backend, microservices" },
  ] },
  { kind: "fit", heading: "Fit", items: [] }, { kind: "bonus", heading: "Bonus", items: [] }, { kind: "anti", heading: "Anti", items: [] },
]
const JOB = { title: "Backend Engineer", company: "Photon", descriptionMd: "High-concurrency backend for messaging, phone and SMS." }
const CANDIDATE = { name: "Daphne-shaped", currentRole: "Senior Software Engineer - Office of the CTO", currentCompany: "Microsoft", yoe: "8.2", notes: "YC Startup School cohort." }

// Verbatim stored order (oldest first); the CURRENT senior role is absent from this array.
const STORED = [
  { title: "Data Analyst", company: "NASA Goddard Space Flight Center", dates: "June 2018–August 2018" },
  { title: "Software Engineer and Program Manager - Azure IoT", company: "Microsoft", dates: "June 2020–August 2020" },
  { title: "Software Engineer - Facebook Marketplace", company: "Meta", dates: "January 2021–April 2021" },
  { title: "AI Education Researcher", company: "AI4ALL", dates: "April 2021–May 2021" },
  { title: "CS and AI Education Researcher", company: "Princeton University", dates: "September 2020–June 2021" },
  { title: "Software Engineer - Azure IoT", company: "Microsoft", dates: "May 2021–July 2021", description: "Azure IoT Central microservices exporting telemetry to Event Grid (Golang, TypeScript)." },
  { title: "Founding Project Lead & Software Engineer", company: "food 4 u", dates: "September 2021–May 2022" },
  { title: "Software Engineer - Machine Learning and Synthetic Data", company: "Microsoft", dates: "May 2022–August 2022" },
  { title: "AI and Robotics Researcher", company: "Princeton University", dates: "January 2022–now" },
  { title: "Software Engineer - Mixed Reality Cloud", company: "Microsoft", dates: "2023–December 2025", description: "Golang and TypeScript backend microservices for real-time session routing." },
]
const base = { displayName: "Daphne-shaped", recentRoleTitle: "Senior Software Engineer - Office of the CTO", recentCompany: "Microsoft",
  workHistorySummary: "Senior Software Engineer - Office of the CTO @ Microsoft; Software Engineer II - Mixed Reality Cloud @ Microsoft" }

// BEFORE reproduces the shipped-yesterday rendering: storage order, no truncation note.
const BEFORE = { ...base, experience: STORED }
// AFTER is what loadWekruitProfile now produces: newest-first (the note is added by the renderer).
const AFTER = { ...base, experience: [...STORED].reverse() }

async function run(label: string, profile: unknown) {
  const userText = buildJudgeUserText({
    jobId: "photon-backend-engineer-high-concurrency", job: JOB as never, groups: GROUPS as never,
    candidate: CANDIDATE as never, ticks: {}, submission: {}, research: undefined, wekruitProfile: profile as never,
  })
  const r = (await callWithFallback({ apiKey: OPENAI, systemPrompt: JUDGE_SYSTEM_PROMPT, userText,
    schemaName: "eval_judgment", schema: EVAL_JUDGMENT_JSON_SCHEMA, log: () => {} } as never)) as { rawJson: string }
  const j = JSON.parse(r.rawJson) as { verdict: string; confidence: number; checklist: { hard: { met: number; total: number; gaps: string[] } }; reasons: string[] }
  console.log(`\n=== ${label}`)
  console.log(`    verdict=${j.verdict} conf=${j.confidence} hard=${j.checklist.hard.met}/${j.checklist.hard.total}`)
  console.log(`    gaps  : ${JSON.stringify(j.checklist.hard.gaps.map((g) => g.slice(0, 50)))}`)
  console.log(`    reason: ${(j.reasons[0] ?? "").replace(/\s+/g, " ").slice(0, 200)}`)
}

await run("BEFORE — storage order (oldest first), current role absent", BEFORE)
await run("AFTER  — newest first + truncation note", AFTER)
process.exit(0)
