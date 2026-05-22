#!/usr/bin/env node
/**
 * One-shot prod seed: Photon collaborated company + public prescreen jobs.
 *
 * Writes:
 *   - pa-companies/photon
 *   - pa-jobs/{wekruit-*}
 *   - matching-jobs/{wekruit-*}
 *
 * Idempotent: uses set(..., { merge: true }) and preserves createdAt when
 * re-run. Requires Node 24 and a fresh @pa/pa-orchestrator build because the
 * actual prescreen schema is imported from packages/pa-orchestrator/dist.
 *
 * Run:
 *   source ~/.zshrc && nvm use 24
 *   npm run build --workspace=@pa/pa-orchestrator
 *   node scripts/seed-photon-collab-jobs.mjs
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { PrescreenConfigSchema } from "../packages/pa-orchestrator/dist/index.js"

const PROJECT_ID = "wekruit-5f89b"
const COMPANY_ID = "photon"
const COMPANY_NAME = "Photon"
const WEBSITE_URL = "https://photon.codes/"

function nowIso() {
  return new Date().toISOString()
}

function loadServiceAccount() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return
  const env = readFileSync(".env", "utf8")
  const match = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
  if (!match) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing from .env")
  const credPath = join(tmpdir(), `pa-photon-seed-${Date.now()}.json`)
  writeFileSync(credPath, match[1])
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath
}

function q({
  qId,
  type,
  weight,
  matchThreshold,
  prompt,
  clarifyPrompt,
  keyword,
  hint,
}) {
  return {
    qId,
    type,
    weight,
    matchThreshold,
    prompt: {
      en: prompt,
      zh: prompt,
    },
    clarifyPrompt: {
      en: clarifyPrompt,
      zh: clarifyPrompt,
    },
    keywords: [
      {
        keyword,
        weight: 1,
        hint,
      },
    ],
  }
}

function prescreenConfig(job) {
  const cfg = {
    version: 1,
    jobTitle: job.title,
    company: COMPANY_NAME,
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 2,
    voiceMode: "professional_prescreen",
    level1Reveal: {
      applyUrl: job.applyUrl,
      salaryRange: job.salaryRange,
      nextStepEta: "within 5 business days",
    },
    questions: job.questions,
    lastEditedBy: "codex:seed-photon-collab-jobs",
    lastEditedAt: job.seededAt,
  }
  return PrescreenConfigSchema.parse(cfg)
}

function descriptionMd(job) {
  return `# ${job.title}

**${COMPANY_NAME}**

Full-time - San Francisco, CA - in person - visa sponsorship available

## Why this role exists

Photon builds Spectrum, open-source agent infrastructure that connects AI agents to iMessage, WhatsApp, Telegram, Slack, Discord, Instagram, and other everyday interfaces. Spectrum is built for low-latency, reliable production conversations, and Photon runs unusual macOS-heavy infrastructure to make native iMessage delivery work at scale.

## What you will own

${job.ownership.map((line) => `- ${line}`).join("\n")}

## What Photon is screening for

${job.screening.map((line) => `- ${line}`).join("\n")}

## Strong signals

${job.strongSignals.map((line) => `- ${line}`).join("\n")}

## Compensation

${job.salaryRange}${job.equityRange ? ` base + ${job.equityRange} equity` : ""}`
}

function matchingJobFromJob(job, now) {
  return {
    jobId: job.jobId,
    roleTitle: job.title,
    title: job.title,
    companyName: COMPANY_NAME,
    companyId: COMPANY_ID,
    jobDescription: descriptionMd(job),
    description: descriptionMd(job),
    locationRaw: "San Francisco, CA",
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryRange: job.salaryRange,
    atsApplyUrl: job.applyUrl,
    applyUrl: job.applyUrl,
    primaryUrl: job.applyUrl,
    status: "active",
    dead: false,
    source: "standout",
    sourcePlatform: "standout",
    sourceUrl: job.applyUrl,
    sourceRepo: "wekruit_seed_photon",
    contentHash: `${job.jobId}:${job.sourceId}`,
    roleFunction: job.roleFunction,
    industry: "AI agent infrastructure",
    industryKey: "ai_ml",
    industryEnum: ["ai_ml", "tech_software"],
    industrySector: job.industrySector,
    relevantTags: job.relevantTags,
    requiredSkills: job.requiredSkills,
    seniorityLevel: job.seniorityLevel,
    locationBuckets: ["san_francisco_bay_area"],
    jobType: "full_time",
    sponsorship: true,
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
  }
}

const sharedIndustrySector = [
  "artificial_intelligence_and_machine_learning",
  "software_and_saas",
  "telecommunications",
]

const sharedCompanySignals = [
  "Apple",
  "MacStadium",
  "AWS EC2 Mac",
  "Scaleway Apple Silicon",
  "Cirrus Labs",
  "MacinCloud",
  "Bitrise",
  "CircleCI",
  "GitHub Actions",
  "Buildkite",
  "Codemagic",
  "Xcode Cloud",
  "Beeper",
  "Twilio",
  "LiveKit",
  "Vapi",
  "Bland AI",
  "Retell AI",
  "Pipecat",
  "Sierra",
  "Arcten",
]

const publicCompanyProfile = {
  tagline: "We bring agents to the interfaces millions already use.",
  about:
    "Photon builds Spectrum, agent infrastructure for bringing AI agents into iMessage, WhatsApp, Telegram, Slack, Discord, Instagram, and other everyday interfaces.",
  websiteUrl: WEBSITE_URL,
  hqLocation: "San Francisco",
  teamSize: "8",
  foundedYear: "2025",
  industryLabels: ["software development", "AI", "devtools"],
  funding: {
    totalRaised: "$5.0M",
    stage: "Seed",
  },
  founders: [
    {
      name: "Daniel Tian",
      title: "Cofounder",
      linkedinUrl: "https://www.linkedin.com/in/danieltian316",
    },
    {
      name: "Ryan Zhu",
      title: "Cofounder",
      linkedinUrl: "https://www.linkedin.com/in/ryanzhuuuu",
    },
  ],
}

const seededAt = nowIso()

const jobs = [
  {
    jobId: "wekruit-37429d02-photon-macos-devops",
    legacyJobIds: ["standout-37429d02-photon-macos-devops"],
    sourceId: "37429d02-1f06-48dd-93c7-946129c01344",
    title: "Member of Technical Staff, macOS DevOps",
    applyUrl: "https://standout.work/jobs/37429d02-1f06-48dd-93c7-946129c01344",
    salaryMin: 180000,
    salaryMax: 240000,
    salaryRange: "$180K-$240K base",
    equityRange: "0.1%-0.5%",
    roleFunction: ["software_engineering", "engineering_and_development"],
    industrySector: sharedIndustrySector,
    seniorityLevel: "mid_level",
    relevantTags: [
      "macos_devops",
      "macos_fleet",
      "production_swift",
      "shell_automation",
      "ci_cd_infrastructure",
      "linux_operations",
      "systems_performance",
      "networking",
      "mdm",
      "apple_silicon_virtualization",
    ],
    requiredSkills: [
      "Swift",
      "macOS administration",
      "shell scripting",
      "CI/CD",
      "Linux",
      "production infrastructure",
      "networking",
      "systems performance",
    ],
    ownership: [
      "Build, operate, and scale Photon macOS data center infrastructure.",
      "Develop Swift and shell automation for deployment, monitoring, and fleet operations.",
      "Own CI/CD and developer infrastructure rather than only consuming an existing pipeline.",
      "Debug real production reliability, performance, and systems issues across macOS and Linux.",
    ],
    screening: [
      "2-7 years total in systems, DevOps, SRE, infrastructure, or closely related engineering.",
      "2+ years writing production Swift, not only hobby apps or SwiftUI tutorials.",
      "3+ years operating macOS or Linux systems at meaningful scale.",
      "Hands-on macOS fleet administration, CI/CD ownership, shell automation, on-call, networking, and OS-level performance debugging.",
      "San Francisco in-person availability. This is full-time and not remote.",
    ],
    strongSignals: [
      "Mac fleet or Mac-as-server experience at Apple, MacStadium, AWS EC2 Mac, Scaleway Apple Silicon, Cirrus Labs, MacinCloud, Bitrise, GitHub Actions macOS runners, Buildkite, Codemagic, or Xcode Cloud.",
      "Open-source or talks around Swift tooling, nix-darwin, Tart, Orchard, Lume, osquery, MunkiReport, Fleet, Jamf alternatives, or MacAdmins.",
      "Startup DNA: early employee, founder, first infra hire, or ownership in a seed-to-Series-C environment.",
      "Battle scars in Jamf, Kandji, Mosyle, Apple Business Manager, DEP/ADE, configuration profiles, FileVault escrow, launchd, XPC, Endpoint Security, System Extensions, NetworkExtension, code signing, notarization, or Apple Silicon virtualization.",
    ],
    questions: [
      q({
        qId: "q_production_swift",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.85,
        prompt:
          "Tell me about production Swift you have shipped. What did it do, who used it, and what part did you own?",
        clarifyPrompt:
          "Please make the Swift example concrete: tooling, service, daemon, system component, or automation, plus production usage.",
        keyword: "production_swift",
        hint:
          "Strong match: shipped Swift-based tooling, services, daemons, automation, or system code used in production. Hobby SwiftUI apps or tutorial-level Swift do not satisfy this hard requirement.",
      }),
      q({
        qId: "q_macos_fleet_operations",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.85,
        prompt:
          "What macOS fleet or Mac-as-server infrastructure have you operated at scale? Include deployment, configuration, troubleshooting, and monitoring details.",
        clarifyPrompt:
          "Please name the fleet size or scale, the tooling you used, and one hard operational issue you personally resolved.",
        keyword: "macos_fleet_operations",
        hint:
          "Strong match: hands-on macOS fleet or Mac-as-server operations including configuration, deployment, monitoring, troubleshooting, or MDM. Corporate helpdesk-only work without automation is not enough.",
      }),
      q({
        qId: "q_cicd_shell_automation",
        type: "MUST_HAVE",
        weight: 1.5,
        matchThreshold: 0.85,
        prompt:
          "Describe a CI/CD or automation system you owned end to end. What did you build with shell scripting, and how did it change reliability or developer throughput?",
        clarifyPrompt:
          "Please separate systems you owned from systems you only used. What broke, and how did your automation prevent or detect it?",
        keyword: "cicd_shell_automation",
        hint:
          "Strong match: owned CI/CD, deployment automation, bash/zsh automation, runners, build systems, or release infrastructure end to end. Merely using GitHub Actions or clicking a pipeline is weak.",
      }),
      q({
        qId: "q_production_outage_debugging",
        type: "MUST_HAVE",
        weight: 1.5,
        matchThreshold: 0.85,
        prompt:
          "Walk me through a real production incident or outage you debugged at the OS, networking, or performance layer.",
        clarifyPrompt:
          "Please include the symptom, what you inspected first, the root cause, and what changed after the incident.",
        keyword: "production_outage_debugging",
        hint:
          "Strong match: on-call or production ownership with real outage debugging, networking fundamentals, OS-level metrics, latency, resource contention, reliability, or performance work.",
      }),
      q({
        qId: "q_sf_startup_alignment",
        type: "MUST_HAVE",
        weight: 1,
        matchThreshold: 0.85,
        prompt:
          "This role is full-time in person in San Francisco. Can you work that way, and what startup or zero-to-one environment have you operated in?",
        clarifyPrompt:
          "Please answer both parts: SF in-person availability and the strongest startup, founder, early-employee, or zero-to-one ownership signal.",
        keyword: "sf_startup_alignment",
        hint:
          "Strong match: can work in person in San Francisco and has at least one startup DNA signal such as venture-backed startup, early employee, founder, or first infra owner. Remote-only is not a match.",
      }),
      q({
        qId: "q_sponsorship_status",
        type: "PROBING",
        weight: 0.5,
        matchThreshold: 0.65,
        prompt:
          "Will you need current or future US work visa sponsorship? Photon can sponsor; this helps plan the process.",
        clarifyPrompt:
          "Please share the current status only at a high level, such as citizen, green card, OPT, H-1B, or sponsorship needed.",
        keyword: "sponsorship_status",
        hint:
          "Collects work-authorization logistics. Sponsorship need is not a disqualifier because this role lists visa sponsorship.",
      }),
    ],
    seededAt,
  },
  {
    jobId: "wekruit-973f2953-photon-objective-c-engineer",
    legacyJobIds: ["standout-973f2953-photon-objective-c-engineer"],
    sourceId: "973f2953-63bb-494e-b695-c104d459a63c",
    title: "Member of Technical Staff, Objective-C",
    applyUrl: "https://standout.work/jobs/973f2953-63bb-494e-b695-c104d459a63c",
    salaryMin: 150000,
    salaryMax: 225000,
    salaryRange: "$150K-$225K",
    equityRange: null,
    roleFunction: ["software_engineering", "engineering_and_development"],
    industrySector: sharedIndustrySector,
    seniorityLevel: "mid_level",
    relevantTags: [
      "objective_c",
      "macos_runtime",
      "system_frameworks",
      "reverse_engineering",
      "systems_programming",
      "performance_reliability",
      "c_cpp",
      "swift",
      "rust",
      "apple_ecosystem",
    ],
    requiredSkills: [
      "Objective-C",
      "macOS",
      "reverse engineering",
      "C/C++",
      "Swift",
      "Rust",
      "systems programming",
      "performance",
      "reliability",
    ],
    ownership: [
      "Design and build core infrastructure and system components for Photon.",
      "Work close to the macOS runtime and Apple system frameworks.",
      "Solve systems-level performance, reliability, and integration problems.",
      "Maintain a high bar for clean, high-quality code while using AI agents to accelerate output.",
    ],
    screening: [
      "Strong production Objective-C background, not only UIKit or simple iOS application work.",
      "Deep macOS or Apple ecosystem experience, especially runtime, system frameworks, daemons, integration, or low-level debugging.",
      "Reverse engineering skill is a core signal for this role.",
      "Systems judgment around performance, reliability, and integration issues.",
      "San Francisco in-person availability. This is full-time and not remote.",
    ],
    strongSignals: [
      "Apple Core OS, CoreServices, Messages, internal tools, runtime, or infrastructure experience.",
      "Objective-C plus C/C++, Swift, or Rust in production systems or tooling.",
      "launchd, XPC, Endpoint Security, System Extensions, NetworkExtension, code signing, notarization, entitlements, or private-framework debugging.",
      "Open-source, blog, or talk evidence around macOS internals, reverse engineering, or Apple ecosystem tooling.",
    ],
    questions: [
      q({
        qId: "q_objective_c_depth",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.85,
        prompt:
          "Tell me about your deepest production Objective-C work. What did you build, and what Objective-C or runtime details mattered?",
        clarifyPrompt:
          "Please avoid a generic app summary. What Objective-C-specific problem did you solve, and what shipped to real users or production systems?",
        keyword: "objective_c_depth",
        hint:
          "Strong match: production Objective-C with runtime, system integration, tooling, or infrastructure depth. Pure UIKit feature work with no systems depth is weak.",
      }),
      q({
        qId: "q_macos_runtime_systems",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.85,
        prompt:
          "What have you built close to the macOS runtime or system frameworks? Include daemons, XPC, launchd, entitlements, extensions, or framework-level integration if relevant.",
        clarifyPrompt:
          "Please name the macOS framework or runtime area and one concrete debugging or integration problem you owned.",
        keyword: "macos_runtime_systems",
        hint:
          "Strong match: deep macOS runtime, Apple system frameworks, launchd, XPC, Endpoint Security, System Extensions, NetworkExtension, code signing, notarization, or entitlement work.",
      }),
      q({
        qId: "q_reverse_engineering",
        type: "MUST_HAVE",
        weight: 1.5,
        matchThreshold: 0.85,
        prompt:
          "Describe reverse engineering work you have done. What were you trying to understand, what tools did you use, and what changed because of it?",
        clarifyPrompt:
          "Please make the reverse-engineering example specific: target, tools, constraints, and outcome.",
        keyword: "reverse_engineering",
        hint:
          "Strong match: skilled reverse engineering for macOS, Apple frameworks, protocols, binaries, integration behavior, or debugging undocumented systems. No reverse-engineering exposure is a miss for this role.",
      }),
      q({
        qId: "q_systems_reliability",
        type: "PROBING",
        weight: 1,
        matchThreshold: 0.65,
        prompt:
          "Give an example of a systems-level performance, reliability, or integration problem you solved.",
        clarifyPrompt:
          "Please include the observable symptom, root cause, and how you verified the fix.",
        keyword: "systems_reliability",
        hint:
          "Strong match: OS-level, runtime-level, performance, reliability, or integration debugging with clear root cause and verification.",
      }),
      q({
        qId: "q_code_quality_ai_agents",
        type: "PROBING",
        weight: 0.75,
        matchThreshold: 0.65,
        prompt:
          "Photon cares about clean code and AI-agent leverage. How do you keep quality high while using AI tools or agents to move faster?",
        clarifyPrompt:
          "Please give a concrete workflow: review, tests, guardrails, or examples where AI helped without lowering quality.",
        keyword: "code_quality_ai_agents",
        hint:
          "Strong match: clear engineering quality habits plus practical AI-agent workflow. Empty AI enthusiasm without code quality discipline is weak.",
      }),
      q({
        qId: "q_sf_in_person",
        type: "MUST_HAVE",
        weight: 1,
        matchThreshold: 0.85,
        prompt:
          "This role is full-time in person in San Francisco. Can you work that way?",
        clarifyPrompt:
          "Please confirm whether you are already in the Bay Area or can relocate immediately for in-person work.",
        keyword: "sf_in_person",
        hint:
          "Strong match: already in the SF Bay Area or willing to relocate immediately for full-time in-person work. Remote-only is not a match.",
      }),
    ],
    seededAt,
  },
]

for (const job of jobs) {
  job.prescreenConfig = prescreenConfig(job)
  job.descriptionMd = descriptionMd(job)
}

function publicJobFromJob(job, now, createdAt) {
  return {
    jobId: job.jobId,
    companyId: COMPANY_ID,
    company: COMPANY_NAME,
    companyName: COMPANY_NAME,
    title: job.title,
    location: "San Francisco, CA (in-person)",
    rawLocation: "San Francisco, CA",
    descriptionMd: job.descriptionMd,
    prescreenConfig: job.prescreenConfig,
    sourceUrl: job.applyUrl,
    sourcePlatform: "standout",
    atsApplyUrl: job.applyUrl,
    applyUrl: job.applyUrl,
    companyProfile: publicCompanyProfile,
    publicVisible: true,
    candidatePageStatus: "published",
    wekruitCollaborationStatus: "collaborated",
    roleFunction: job.roleFunction,
    industrySector: job.industrySector,
    relevantTags: job.relevantTags,
    requiredSkills: job.requiredSkills,
    seniorityLevel: job.seniorityLevel,
    locationBuckets: ["san_francisco_bay_area"],
    jobType: "full_time",
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryRange: job.salaryRange,
    sponsorship: true,
    status: "active",
    dead: false,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt,
    seededAt: createdAt,
    updatedAt: now,
  }
}

async function main() {
  loadServiceAccount()
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
  }
  const db = getFirestore()
  const now = nowIso()

  const companyRef = db.collection("pa-companies").doc(COMPANY_ID)
  const companySnap = await companyRef.get()
  const companyCreatedAt =
    typeof companySnap.data()?.createdAt === "string" ? companySnap.data().createdAt : now

  const batch = db.batch()
  batch.set(
    companyRef,
    {
      companyId: COMPANY_ID,
      id: COMPANY_ID,
      name: COMPANY_NAME,
      displayName: COMPANY_NAME,
      normalizedName: COMPANY_ID,
      domain: "photon.codes",
      websiteUrl: WEBSITE_URL,
      careersUrl: "https://standout.work/jobs/37429d02-1f06-48dd-93c7-946129c01344",
      description:
        "Photon builds Spectrum, open-source agent infrastructure for delivering AI agents into iMessage, WhatsApp, Telegram, Slack, Discord, Instagram, and other everyday interfaces.",
      hqLocation: "San Francisco, CA",
      employeeRange: "1-10",
      size: "early_startup",
      industry: "AI agent infrastructure",
      industrySector: sharedIndustrySector,
      companyStage: "seed",
      companyTags: ["ai_native", "devtools", "agent_infrastructure", "messaging_infrastructure"],
      competitorCompanies: sharedCompanySignals,
      totalRaisedUsdMillions: 5,
      backing: "venture-backed",
      logoUrl: null,
      enrichmentSource: "manual",
      enrichedAt: now,
      lastReviewedBy: "codex:seed-photon-collab-jobs",
      wekruitCollab: true,
      jobsCount: jobs.length,
      jobsCountUpdatedAt: now,
      createdAt: companyCreatedAt,
      updatedAt: now,
    },
    { merge: true },
  )

  for (const job of jobs) {
    const paRef = db.collection("pa-jobs").doc(job.jobId)
    const matchingRef = db.collection("matching-jobs").doc(job.jobId)
    const paSnap = await paRef.get()
    const jobCreatedAt =
      typeof paSnap.data()?.createdAt === "string" ? paSnap.data().createdAt : now
    batch.set(paRef, publicJobFromJob(job, now, jobCreatedAt), { merge: true })
    batch.set(matchingRef, matchingJobFromJob(job, now), { merge: true })
    for (const legacyJobId of job.legacyJobIds ?? []) {
      if (legacyJobId === job.jobId) continue
      batch.delete(db.collection("pa-jobs").doc(legacyJobId))
      batch.delete(db.collection("matching-jobs").doc(legacyJobId))
    }
  }

  await batch.commit()

  console.log(`seeded pa-companies/${COMPANY_ID}`)
  for (const job of jobs) {
    console.log(`seeded pa-jobs/${job.jobId}`)
    console.log(`seeded matching-jobs/${job.jobId}`)
    console.log(`public URL: https://candidate.wekruit.com/j/${job.jobId}`)
    console.log(`admin URL: https://wekruit-pa.web.app/admin/jobs/${job.jobId}/prescreen`)
    console.log(`questions: ${job.prescreenConfig.questions.map((question) => question.qId).join(", ")}`)
  }
}

main().catch((err) => {
  console.error("[seed-photon] FAILED:", err)
  process.exit(1)
})
