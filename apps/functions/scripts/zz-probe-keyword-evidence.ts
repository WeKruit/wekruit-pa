/**
 * REAL-LLM probe for the "a named technology is not experience with it" judge rule.
 *
 * Adam 2026-07-26: "a lot of time some resume mention about keyword but don't actually show
 * experience… someone mention distributed system as skill whereas never done something to support
 * this." A stub judge cannot catch a prompt rule that over- or under-fires, so this runs the
 * SHIPPED system prompt against the real router with two OPPOSITE résumés:
 *
 *   STUFFER — fat skills inventory naming Rust / distributed systems / Kafka / microservices, but
 *             every experience bullet is CRUD screens and ticket triage.
 *             EXPECT: stack + high-concurrency items GAPPED, verdict NOT advance.
 *   BUILDER — no skills section at all; the bullets describe building and owning the system.
 *             EXPECT: those same items MET. The rule must not make the judge blind to real work
 *             just because nobody wrote a keyword list.
 *
 * The second case is the guard that matters: a rule that only ever subtracts would gap everyone.
 *
 * Read-only: no Firestore, no writes, no sends.
 *   source ~/.zshrc && nvm use 24
 *   node --import tsx apps/functions/scripts/zz-probe-keyword-evidence.ts
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
      { id: "high_concurrency_ownership", text: "Can explain personal ownership of a high-concurrency, distributed, messaging, or reliability-sensitive backend system" },
      { id: "sf_full_time", text: "Available for full-time, in-person work in San Francisco" },
    ],
  },
  { kind: "fit", heading: "Strong fit signals", items: [{ id: "messaging_telecom", text: "Messaging, SMS or telecommunications experience" }] },
  { kind: "bonus", heading: "Bonuses", items: [] },
  { kind: "anti", heading: "Anti-signals", items: [{ id: "one_or_zero_stack", text: "Only one or none of the four core areas with concrete implementation evidence" }] },
]

const JOB = {
  title: "Backend Engineer",
  company: "Photon",
  descriptionMd:
    "Build high-concurrency backend systems for messaging, phone and SMS. Full-time, in-person in San Francisco.",
}

const STUFFER_RESUME = `JORDAN PARK — Software Engineer

SKILLS
Languages: TypeScript, JavaScript, Rust, Go, Python, SQL
Backend: Node.js, microservices, distributed systems, Kafka, RabbitMQ, Redis, gRPC
Cloud: AWS, Kubernetes, Docker, Terraform, observability, high availability, scalability

EXPERIENCE
Software Engineer — Meridian Retail Group (March 2019 – present)
- Built and maintained internal admin screens in React for the merchandising team.
- Added form validation and CSV export to the product catalogue tool.
- Fixed bugs reported through the support queue and updated Jira tickets.
- Wrote SQL reports for the finance team's monthly close.
- Participated in code review and sprint planning.

Junior Developer — Comet Digital (June 2017 – February 2019)
- Updated WordPress themes and landing pages for small business clients.
- Ran manual QA passes before releases.

EDUCATION
B.S. Information Systems, State University (2017)`

const BUILDER_RESUME = `SAM OKONKWO — Engineer

EXPERIENCE
Engineer — Tessell (August 2019 – present)
- Wrote the message-routing service that fans every inbound SMS out to per-tenant
  handlers. I own it end to end: schema, deploy, on-call pager. It carries about
  22k messages a minute at peak across ~400 tenants.
- Rewrote the delivery-retry path in Rust after the Node version fell over under
  a carrier outage; tail latency went from 4s to 300ms and it has not paged since.
- Split the original single service into six Node/TypeScript services so teams
  could deploy independently, and ran the migration myself over four months.
- Set up the tracing and alerting we use now, and ran the postmortems for the two
  outages we had in 2024.

Engineer — Halden Systems (July 2016 – July 2019)
- Maintained a billing pipeline that reconciled usage records nightly.

EDUCATION
B.Eng. Electrical Engineering, State University (2016)`

const CASES = [
  {
    label: "STUFFER — keywords in the skills list, CRUD work in the bullets",
    expect: "stack + high-concurrency items GAPPED; verdict not advance",
    candidate: {
      name: "Jordan Park",
      currentRole: "Software Engineer",
      currentCompany: "Meridian Retail Group",
      yoe: "8",
      notes: "Strong distributed systems and Rust background per the résumé skills section.",
    },
    resumeText: STUFFER_RESUME,
    // Recruiter over-claims exactly the two items the skills list "supports".
    ticks: { five_years_programming: true, two_of_four_stack: true, high_concurrency_ownership: true },
  },
  {
    label: "BUILDER — no skills section, the work is in the bullets",
    expect: "same items MET; the rule must not gap real work for lack of a keyword list",
    candidate: {
      name: "Sam Okonkwo",
      currentRole: "Engineer",
      currentCompany: "Tessell",
      yoe: "9",
      notes: "",
    },
    resumeText: BUILDER_RESUME,
    ticks: {},
  },
]

const HIT = (gaps: string[], re: RegExp) => gaps.some((g) => re.test(g))

async function main() {
  let failures = 0
  for (const c of CASES) {
    const userText = buildJudgeUserText({
      jobId: "photon-backend-engineer-high-concurrency",
      job: JOB as never,
      groups: GROUPS as never,
      candidate: c.candidate as never,
      ticks: c.ticks as never,
      submission: {},
      research: undefined,
      resumeText: c.resumeText,
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
    const gaps = j.checklist.hard.gaps
    const stackGapped = HIT(gaps, /Rust, Swift, TypeScript|core (technology )?areas|implementation evidence/i)
    const concGapped = HIT(gaps, /high-concurrency|distributed|messaging|reliability-sensitive/i)

    const isStuffer = c.label.startsWith("STUFFER")
    const ok = isStuffer
      ? stackGapped && concGapped && j.verdict !== "advance"
      : !stackGapped && !concGapped
    if (!ok) failures++

    console.log(`\n=== ${c.label}`)
    console.log(`    expect: ${c.expect}`)
    console.log(`    verdict=${j.verdict} conf=${j.confidence} hard=${j.checklist.hard.met}/${j.checklist.hard.total}`)
    console.log(`    stack gapped? ${stackGapped ? "YES" : "no"}   high-concurrency gapped? ${concGapped ? "YES" : "no"}`)
    console.log(`    ${ok ? "PASS <-- rule working" : "FAIL <-- rule NOT working"}`)
    console.log(`    gaps: ${JSON.stringify(gaps)}`)
    console.log(`    reasons: ${j.reasons.slice(0, 4).map((x) => x.slice(0, 130)).join("\n             ")}`)
  }
  console.log(`\n${failures === 0 ? "ALL CASES PASS" : `${failures} CASE(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
