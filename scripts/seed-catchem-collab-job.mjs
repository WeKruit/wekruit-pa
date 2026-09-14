#!/usr/bin/env node
/**
 * One-shot prod seed: Catchem collaborated company + public Founding CEO role.
 *
 * Source: Catchem_ Founder Job Position (1).pdf supplied by Adam.
 *
 * Writes:
 *   - pa-companies/catchem
 *   - pa-jobs/catchem-founding-ceo
 *   - matching-jobs/catchem-founding-ceo
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { PrescreenConfigSchema } from "../packages/pa-orchestrator/dist/index.js"

const PROJECT_ID = "wekruit-5f89b"
export const COMPANY_ID = "catchem"
export const COMPANY_NAME = "Catchem"
export const JOB_ID = "catchem-founding-ceo"
const PUBLIC_JOB_URL = `https://candidate.wekruit.com/j/${JOB_ID}`
const SOURCE_URL = PUBLIC_JOB_URL
const COMP_RANGE = "$2.5K-$4K/month initial 6-month period + founder-level equity"

function nowIso() {
  return new Date().toISOString()
}

function loadServiceAccount() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return
  const env = readFileSync(".env", "utf8")
  const match = env.match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.+)$/m)
  if (!match) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing from .env")
  const credPath = join(tmpdir(), `pa-catchem-seed-${Date.now()}.json`)
  writeFileSync(credPath, match[1])
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath
}

function q({ qId, type, weight, matchThreshold, prompt, clarifyPrompt, keyword, hint }) {
  return {
    qId,
    type,
    weight,
    matchThreshold,
    prompt: { en: prompt, zh: prompt },
    clarifyPrompt: { en: clarifyPrompt, zh: clarifyPrompt },
    keywords: [{ keyword, weight: 1, hint }],
  }
}

const industrySector = ["crypto_web3_blockchain", "consumer_retail", "financial_technology", "gaming_and_esports"]
const roleFunction = ["management_and_executive", "product_management", "marketing", "sales"]
const locationBuckets = ["remote_united_states"]
const seededAt = nowIso()

export const job = {
  jobId: JOB_ID,
  title: "Founding CEO",
  company: COMPANY_NAME,
  applyUrl: PUBLIC_JOB_URL,
  sourceUrl: SOURCE_URL,
  salaryRange: COMP_RANGE,
  roleFunction,
  industrySector,
  locationBuckets,
  seniorityLevel: "c_level",
  relevantTags: [
    "founding_ceo",
    "founder_level_ownership",
    "tokenized_collectibles",
    "trading_cards",
    "graded_cards",
    "consumer_marketplace",
    "crypto_web3",
    "community_growth",
    "go_to_market",
    "fundraising",
    "startup_operator",
  ],
  requiredSkills: [
    "Founder-level ownership",
    "startup execution",
    "consumer growth",
    "community building",
    "collectibles or trading cards",
    "crypto or web3 familiarity",
    "partnerships",
    "fundraising readiness",
    "operations",
  ],
  seededAt,
}

const companyProfile = {
  tagline: "Tokenized graded trading cards with a provably fair gacha marketplace.",
  about:
    "Catchem brings graded trading cards on-chain. Collectors vault physical slabs, receive digital versions, and can sell, hold, trade, or load cards into a provably fair gacha machine backed by real vaulted cards.",
  hqLocation: "Remote, United States",
  industryLabels: ["collectibles", "trading cards", "crypto", "marketplace", "consumer"],
  funding: {
    stage: "pre-launch",
    backing: "Follow-on investment of up to $500K available after the evaluation period.",
  },
}

function bulletList(lines) {
  return lines.map((line) => `- ${line}`).join("\n")
}

function descriptionMd() {
  return `# Founding CEO

**Catchem**

Full-time - Remote (United States)

## Company context

Catchem is a platform for bringing graded trading cards on-chain. Collectors ship graded cards to a professionally managed, insured vault and receive a digital version of each card on-chain. They can sell it instantly on the marketplace, hold it, trade it, or load it into Catchem's gacha machine.

The gacha product is the center of the business: users spin for a chance to pull real graded cards, every token is backed by a physical slab in the vault, and every result is designed to be provably fair and verifiable on-chain. Winners can keep the card, sell it back, trade it, or have the physical slab shipped to them.

The product is already built: consumer app, marketplace, vault and fulfillment integration, admin platform, and go-to-market plan.

## Why this role exists

Catchem needs a Founding CEO to take founder-level ownership of launch and everything after it: growth, community, marketing, partnerships across collectibles and crypto, operations, and fundraising.

## What you will own

${bulletList([
    "Run Catchem as your own company, with founder-level ownership and responsibility for the outcome.",
    "Own launch, community, growth, marketing, and partnerships in the collectibles and crypto ecosystems.",
    "Operate the vault-backed marketplace and gacha business with enough rigor to build trust with collectors.",
    "Drive fundraising and investor storytelling after the initial proving period.",
  ])}

## What Catchem is screening for

${bulletList([
    "Recent graduate with a technical background in software engineering, product management, or technical project leadership.",
    "Has already attempted a venture, startup, shipped project, or meaningful zero-to-one build.",
    "Genuine collector or card enthusiast across TCGs, sports cards, or graded collectibles.",
    "Comfort being the public face of a company: posting, community building, and showing up.",
    "Crypto or web3 experience is a plus, not a strict requirement.",
  ])}

## Compensation and structure

${COMP_RANGE}. Follow-on investment of up to $500K is available after the evaluation period.

## Interview process

2-3 rounds with the hiring manager.`
}

function buildPrescreenConfig(now) {
  return PrescreenConfigSchema.parse({
    version: 1,
    jobTitle: job.title,
    company: COMPANY_NAME,
    threshold: 0.65,
    confidenceThreshold: 0.7,
    maxClarifyRounds: 2,
    voiceMode: "professional_prescreen",
    level1Reveal: {
      applyUrl: PUBLIC_JOB_URL,
      salaryRange: COMP_RANGE,
      nextStepEta: "2-3 interview rounds with the hiring manager",
    },
    questions: [
      q({
        qId: "q_founder_attempt",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.8,
        prompt:
          "Tell me about a venture, startup, shipped project, or zero-to-one build you personally owned. What happened, and what would you do differently now?",
        clarifyPrompt:
          "Please include what you owned directly, what shipped or launched, and one lesson you would apply if you ran Catchem.",
        keyword: "founder_attempt",
        hint: "Evidence of founder-level ownership, a shipped venture/project, and self-awareness from the grind.",
      }),
      q({
        qId: "q_collector_domain",
        type: "MUST_HAVE",
        weight: 2,
        matchThreshold: 0.75,
        prompt:
          "What is your personal connection to trading cards, TCGs, sports cards, or graded collectibles?",
        clarifyPrompt:
          "Please be specific: what you collect, buy, sell, follow, or understand about why collectors value graded cards.",
        keyword: "collector_domain",
        hint: "Genuine card or collectibles enthusiasm; understands why collectors care about graded slabs.",
      }),
      q({
        qId: "q_growth_community",
        type: "PROBING",
        weight: 1.5,
        matchThreshold: 0.65,
        prompt:
          "If you had to launch Catchem in the next 60 days, what would your first growth and community plan look like?",
        clarifyPrompt:
          "Please cover audience, channels, content/community motion, partnerships, and the metric you would watch first.",
        keyword: "growth_community",
        hint: "Practical launch plan across collectors, crypto, community, content, and partnerships.",
      }),
      q({
        qId: "q_crypto_marketplace",
        type: "PROBING",
        weight: 1,
        matchThreshold: 0.6,
        prompt:
          "What is your experience with crypto, web3, marketplaces, or tokenized real-world assets?",
        clarifyPrompt:
          "It is okay if crypto is not your main background. Share what you have used, built, researched, invested in, or learned.",
        keyword: "crypto_marketplace",
        hint: "Crypto/web3 is a plus, not required; marketplace or tokenized asset intuition is valuable.",
      }),
      q({
        qId: "q_public_face",
        type: "PROBING",
        weight: 1,
        matchThreshold: 0.6,
        prompt:
          "This CEO needs to be the public face of Catchem. How comfortable are you posting, building in public, talking to users, and representing the company every day?",
        clarifyPrompt:
          "Please give an example of public-facing work, community work, sales, content, or user conversations you have done.",
        keyword: "public_face",
        hint: "Comfort being visible: posting, community building, user conversations, partnerships, and founder-led storytelling.",
      }),
      q({
        qId: "q_comp_structure",
        type: "MUST_HAVE",
        weight: 1,
        matchThreshold: 0.8,
        prompt:
          "Are you aligned with the structure: $2.5K-$4K per month for the first 6-month proving period, founder-level equity, and founder-level responsibility?",
        clarifyPrompt:
          "Please confirm whether that cash/equity structure works for you and whether you can commit full-time.",
        keyword: "comp_structure",
        hint: "Confirms full-time availability and acceptance of low initial cash plus founder-level equity/responsibility.",
      }),
    ],
    lastEditedBy: "codex:seed-catchem-collab-job",
    lastEditedAt: now,
  })
}

export function buildMatchingJob(now) {
  const description = descriptionMd()
  return {
    jobId: JOB_ID,
    roleTitle: job.title,
    title: job.title,
    companyName: COMPANY_NAME,
    companyId: COMPANY_ID,
    jobDescription: description,
    description,
    locationRaw: "Remote (United States)",
    salaryRange: COMP_RANGE,
    atsApplyUrl: PUBLIC_JOB_URL,
    applyUrl: PUBLIC_JOB_URL,
    primaryUrl: PUBLIC_JOB_URL,
    status: "active",
    dead: false,
    source: "manual",
    sourcePlatform: "manual",
    sourceUrl: SOURCE_URL,
    sourceRepo: "wekruit_seed_catchem",
    contentHash: `${JOB_ID}:catchem-founder-job-position-pdf`,
    roleFunction: job.roleFunction,
    industry: "Tokenized collectibles",
    industryKey: "crypto_web3",
    industryEnum: ["crypto_web3", "consumer"],
    industrySector: job.industrySector,
    relevantTags: job.relevantTags,
    requiredSkills: job.requiredSkills,
    seniorityLevel: job.seniorityLevel,
    locationBuckets: job.locationBuckets,
    jobType: "full_time",
    sponsorship: false,
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
  }
}

function buildRecruiterBoard(now) {
  return {
    active: true,
    sortOrder: 275,
    updatedAt: now,
    interviewProcess: "2-3 rounds with the hiring manager.",
    priority: {
      tier: "normal",
      rank: 275,
      note: "Founder CEO role from Catchem PDF JD.",
      emailAudience: "founders, operators, growth/community builders, crypto and collectibles candidates",
      updatedAt: now,
      updatedByEmail: "codex@wekruit.com",
    },
    label: {
      company: COMPANY_NAME,
      companyCode: "CATCHEM",
      location: "Remote (United States)",
      pills: [
        { text: "Founder CEO", tone: "warm" },
        { text: "Full-time", tone: "neutral" },
        { text: "Remote US", tone: "cool" },
      ],
    },
    culture: {
      bet: "Catchem is already built; this person owns launch, distribution, community, operations, and fundraising like a founder.",
      bullets: [
        "Founder-level ownership, not a normal hired-executive seat.",
        "Best candidates combine zero-to-one execution with real collector/card obsession.",
        "Crypto/web3 helps, but collectibles taste and launch grit matter more.",
      ],
    },
    checklist: {
      groups: [
        {
          kind: "hard",
          heading: "Must have",
          items: [
            { id: "technical_or_product_background", text: "Recent graduate or early-career operator with technical, product, or technical-project background." },
            { id: "founder_attempt_or_shipped_project", text: "Has attempted a venture, startup, or shipped meaningful zero-to-one project." },
            { id: "collector_or_card_enthusiast", text: "Genuine trading card, TCG, sports card, or graded collectibles interest." },
            { id: "comp_structure_aligned", text: "Aligned with low initial cash, founder-level equity, and full-time founder-level responsibility." },
          ],
        },
        {
          kind: "fit",
          heading: "Strong fit",
          items: [
            { id: "growth_community_instinct", text: "Can build launch plan, content/community motion, and partnerships without waiting for a playbook." },
            { id: "public_face_comfort", text: "Comfortable posting, talking to users, building in public, and being the face of Catchem." },
            { id: "fundraising_storytelling", text: "Can tell the market story and credibly help with investor conversations after proving period." },
          ],
        },
        {
          kind: "bonus",
          heading: "Bonus",
          items: [
            { id: "crypto_or_web3_experience", text: "Crypto, web3, tokenized asset, or marketplace experience." },
            { id: "collectibles_network", text: "Existing network in cards, collectors, breakers, shops, creators, or crypto communities." },
          ],
        },
        {
          kind: "anti",
          heading: "Watch outs",
          items: [
            { id: "wants_operator_job_only", text: "Wants a predictable employee/operator job rather than founder-level ownership." },
            { id: "no_collector_interest", text: "No real interest in trading cards, collectibles, or collector psychology." },
            { id: "strategy_without_execution", text: "Talks strategy but avoids posting, selling, partnerships, operations, or hands-on launch work." },
          ],
        },
      ],
    },
  }
}

export function buildPublicJob(now, createdAt) {
  return {
    jobId: JOB_ID,
    companyId: COMPANY_ID,
    company: COMPANY_NAME,
    companyName: COMPANY_NAME,
    title: job.title,
    location: "Remote (United States)",
    rawLocation: "Remote (United States)",
    descriptionMd: descriptionMd(),
    prescreenConfig: buildPrescreenConfig(now),
    recruiterBoard: buildRecruiterBoard(now),
    sourceUrl: SOURCE_URL,
    sourcePlatform: "manual",
    atsApplyUrl: PUBLIC_JOB_URL,
    applyUrl: PUBLIC_JOB_URL,
    companyProfile,
    publicVisible: true,
    candidatePageStatus: "published",
    wekruitCollaborationStatus: "collaborated",
    roleFunction: job.roleFunction,
    industrySector: job.industrySector,
    relevantTags: job.relevantTags,
    requiredSkills: job.requiredSkills,
    seniorityLevel: job.seniorityLevel,
    locationBuckets: job.locationBuckets,
    jobType: "full_time",
    salaryRange: COMP_RANGE,
    compSummary: COMP_RANGE,
    sponsorship: false,
    status: "active",
    dead: false,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt,
    seededAt: createdAt,
    updatedAt: now,
  }
}

function buildCompany(now, createdAt) {
  return {
    companyId: COMPANY_ID,
    id: COMPANY_ID,
    name: COMPANY_NAME,
    displayName: COMPANY_NAME,
    normalizedName: COMPANY_ID,
    domain: null,
    websiteUrl: null,
    careersUrl: PUBLIC_JOB_URL,
    description: companyProfile.about,
    hqLocation: "Remote (United States)",
    size: "pre-launch",
    industry: "Tokenized collectibles",
    industrySector,
    companyStage: "pre-launch",
    companyTags: ["crypto_web3", "collectibles", "trading_cards", "consumer_marketplace", "gacha"],
    competitorCompanies: ["Collector Crypt", "Courtyard", "Only Gems", "TCGplayer", "eBay", "Whatnot"],
    backing: companyProfile.funding.backing,
    logoUrl: null,
    publicCompanyProfile: companyProfile,
    enrichmentSource: "manual",
    enrichedAt: now,
    lastReviewedBy: "codex:seed-catchem-collab-job",
    wekruitCollab: true,
    jobsCount: 1,
    jobsCountUpdatedAt: now,
    createdAt,
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

  const paRef = db.collection("pa-jobs").doc(JOB_ID)
  const matchingRef = db.collection("matching-jobs").doc(JOB_ID)
  const paSnap = await paRef.get()
  const jobCreatedAt =
    typeof paSnap.data()?.createdAt === "string" ? paSnap.data().createdAt : now

  const batch = db.batch()
  batch.set(companyRef, buildCompany(now, companyCreatedAt), { merge: true })
  batch.set(paRef, buildPublicJob(now, jobCreatedAt), { merge: true })
  batch.set(matchingRef, buildMatchingJob(now), { merge: true })
  await batch.commit()

  console.log(`seeded pa-companies/${COMPANY_ID}`)
  console.log(`seeded pa-jobs/${JOB_ID}`)
  console.log(`seeded matching-jobs/${JOB_ID}`)
  console.log(`public URL: ${PUBLIC_JOB_URL}`)
  console.log(`admin URL: https://wekruit-pa.web.app/admin/jobs/${JOB_ID}/prescreen`)
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[seed-catchem] FAILED:", err)
    process.exit(1)
  })
}
