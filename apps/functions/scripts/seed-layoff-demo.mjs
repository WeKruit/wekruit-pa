#!/usr/bin/env node
/**
 * seed-layoff-demo.mjs - write the 107-row layoff preview pool into pa-users as
 * `isDemo: true` documents.
 *
 * Usage:
 *   source .env
 *   node apps/functions/scripts/seed-layoff-demo.mjs
 *
 * Re-running is idempotent: docs are keyed `demo_layoff_{NN}` so subsequent
 * runs upsert the same 24 ids rather than appending.
 *
 * Schema written per doc (pa-users):
 *   - source: "WeKruit_Laid_Off"
 *   - isDemo: true
 *   - getHired: false
 *   - displayName: "Maya C."
 *   - phoneE164: "+155500{idx}"
 *   - onboardingStatus: "complete"
 *   - lastLaidOffAt: Timestamp derived from minAgo
 *   - layoffContext: { lastCompany, jobTitle, location, function }
 *   - demoSourcePool: "TALENT_POOL_v2"
 */
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, Timestamp } from "firebase-admin/firestore"

const PROJECT = "wekruit-5f89b"

function init() {
  if (getApps().length) return
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (inline) {
    initializeApp({ credential: cert(JSON.parse(inline)), projectId: PROJECT })
    return
  }
  initializeApp({ credential: applicationDefault(), projectId: PROJECT })
}

const CURATED_POOL = [
  { idx: 1,  first: "Maya",   last: "C", company: "Meta",       fn: "Product",     title: "Senior PM, Reality Labs",   location: "San Francisco", minAgo: 32,    verified: true  },
  { idx: 2,  first: "Daniel", last: "O", company: "Google",     fn: "Engineering", title: "Staff SWE, Search Infra",   location: "New York",      minAgo: 95,    verified: true  },
  { idx: 3,  first: "Priya",  last: "R", company: "Tesla",      fn: "Design",      title: "Lead Product Designer",     location: "Austin",        minAgo: 180,   verified: true  },
  { idx: 4,  first: "Marcus", last: "B", company: "Stripe",     fn: "Engineering", title: "Senior SWE, Payments",      location: "Remote, US",   minAgo: 420,   verified: true  },
  { idx: 5,  first: "Jen",    last: "T", company: "Salesforce", fn: "GTM",         title: "Enterprise AE",             location: "Chicago",       minAgo: 720,   verified: true  },
  { idx: 6,  first: "Sam",    last: "L", company: "Amazon",     fn: "Product",     title: "PM II, AWS",                location: "Seattle",       minAgo: 1440,  verified: false },
  { idx: 7,  first: "Lina",   last: "K", company: "Microsoft",  fn: "Engineering", title: "Principal SWE, Copilot",    location: "Remote, US",   minAgo: 2880,  verified: true  },
  { idx: 8,  first: "Tobi",   last: "A", company: "Twilio",     fn: "GTM",         title: "Head of CS",                location: "Boston",        minAgo: 3360,  verified: true  },
  { idx: 9,  first: "Rishi",  last: "D", company: "Discord",    fn: "Design",      title: "Senior Brand Designer",     location: "Los Angeles",   minAgo: 4320,  verified: true  },
  { idx: 10, first: "Hana",   last: "Y", company: "Snap",       fn: "Product",     title: "Group PM, AR Camera",       location: "Los Angeles",   minAgo: 14,    verified: true  },
  { idx: 11, first: "Kenji",  last: "M", company: "Atlassian",  fn: "Engineering", title: "Senior SWE, Jira Cloud",    location: "Sydney, Remote", minAgo: 47,  verified: true  },
  { idx: 12, first: "Alex",   last: "P", company: "Cisco",      fn: "Engineering", title: "Tech Lead, Webex",          location: "San Jose",      minAgo: 70,    verified: true  },
  { idx: 13, first: "Naomi",  last: "F", company: "Spotify",    fn: "Design",      title: "Staff Product Designer",    location: "Brooklyn",      minAgo: 130,   verified: true  },
  { idx: 14, first: "Omar",   last: "H", company: "GitHub",     fn: "Engineering", title: "Senior SWE, Copilot",       location: "Remote, US",   minAgo: 215,   verified: true  },
  { idx: 15, first: "Eliza",  last: "N", company: "Cloudflare", fn: "GTM",         title: "Solutions Architect",       location: "Austin",        minAgo: 305,   verified: true  },
  { idx: 16, first: "Diego",  last: "V", company: "Reddit",     fn: "Product",     title: "Senior PM, Community",      location: "San Francisco", minAgo: 510,   verified: false },
  { idx: 17, first: "Ravi",   last: "G", company: "Square",     fn: "Engineering", title: "Staff SWE, Cash App",       location: "Toronto",       minAgo: 830,   verified: true  },
  { idx: 18, first: "Sofia",  last: "M", company: "Lyft",       fn: "Product",     title: "PM, Rideshare Pricing",     location: "San Francisco", minAgo: 1180,  verified: true  },
  { idx: 19, first: "Mei",    last: "X", company: "Notion",     fn: "Design",      title: "Senior Designer, AI",       location: "San Francisco", minAgo: 1700,  verified: true  },
  { idx: 20, first: "Theo",   last: "S", company: "Figma",      fn: "Engineering", title: "Senior SWE, Multiplayer",   location: "New York",      minAgo: 2200,  verified: true  },
  { idx: 21, first: "Aisha",  last: "B", company: "Airbnb",     fn: "GTM",         title: "Sr Manager, Host Ops",      location: "Remote, US",   minAgo: 2640,  verified: true  },
  { idx: 22, first: "Ben",    last: "W", company: "Roblox",     fn: "Engineering", title: "Staff SWE, Platform",       location: "San Mateo",     minAgo: 3600,  verified: true  },
  { idx: 23, first: "Yuki",   last: "T", company: "Dropbox",    fn: "Product",     title: "PM, Smart Sync",            location: "Remote, US",   minAgo: 5040,  verified: false },
  { idx: 24, first: "Iris",   last: "Q", company: "Box",        fn: "GTM",         title: "Director of Sales, Mid-mkt", location: "Chicago",      minAgo: 6480,  verified: true  },
]

const FIRST_NAMES = [
  "Nora", "Ethan", "Amara", "Leo", "Zara", "Mateo", "Mina", "Caleb", "Ari",
  "Leah", "Noel", "Tara", "Ivan", "Mika", "June", "Rene", "Nia", "Owen",
  "Maya", "Theo", "Sana", "Miles", "Ivy", "Kai", "Luca", "Anya", "Eli",
  "Sara", "Rhea", "Max", "Lena", "Drew", "Mila", "Jules", "Nico",
]
const LAST_INITIALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
const COMPANIES = [
  "Meta", "Google", "Amazon", "Microsoft", "Stripe", "Salesforce", "Twilio",
  "Cisco", "Dropbox", "Figma", "Notion", "Lyft", "Airbnb", "Roblox",
  "Cloudflare", "GitHub", "Spotify", "Snap", "Atlassian", "Box",
]
const LOCATIONS = [
  "San Francisco", "New York", "Seattle", "Austin", "Chicago", "Boston",
  "Los Angeles", "Remote, US", "San Jose", "Toronto", "Denver", "Atlanta",
]
const TITLES_BY_FUNCTION = {
  Product: ["Product Manager", "Senior Product Manager", "Group Product Manager", "Product Lead"],
  Engineering: ["Software Engineer", "Senior Software Engineer", "Staff Software Engineer", "Engineering Manager"],
  Design: ["Product Designer", "Senior Product Designer", "UX Designer", "Design Lead"],
  GTM: ["Account Executive", "Customer Success Lead", "Solutions Consultant", "Sales Manager"],
}

function generatedRow(idx) {
  const functions = Object.keys(TITLES_BY_FUNCTION)
  const fn = functions[(idx * 7) % functions.length]
  const titleOptions = TITLES_BY_FUNCTION[fn]
  return {
    idx,
    first: FIRST_NAMES[(idx * 11) % FIRST_NAMES.length],
    last: LAST_INITIALS[(idx * 5) % LAST_INITIALS.length],
    company: COMPANIES[(idx * 13) % COMPANIES.length],
    fn,
    title: titleOptions[(idx * 3) % titleOptions.length],
    location: LOCATIONS[(idx * 17) % LOCATIONS.length],
    minAgo: 18 + ((idx * 137) % (60 * 24 * 14)),
    verified: idx % 7 !== 0,
  }
}

const POOL = [
  ...CURATED_POOL,
  ...Array.from({ length: 83 }, (_, i) => generatedRow(i + 25)),
]

function docId(idx) {
  return `demo_layoff_${String(idx).padStart(3, "0")}`
}

function asFields(row) {
  const laidOffAt = new Date(Date.now() - row.minAgo * 60_000).toISOString()
  const phone = `+155500${String(row.idx).padStart(4, "0")}`
  return {
    id: docId(row.idx),
    source: "WeKruit_Laid_Off",
    isDemo: true,
    getHired: false,
    demoSourcePool: "TALENT_POOL_v2",
    displayName: `${row.first} ${row.last}.`,
    phoneE164: phone,
    onboardingStatus: row.verified ? "complete" : "invited",
    createdAt: laidOffAt,
    lastLaidOffAt: Timestamp.fromDate(new Date(laidOffAt)),
    layoffContext: {
      lastCompany: row.company,
      jobTitle: row.title,
      location: row.location,
      function: row.fn,
      minAgoSeed: row.minAgo,
    },
  }
}

async function upsertOne(row) {
  const id = docId(row.idx)
  const ref = getFirestore().collection("pa-users").doc(id)
  const exists = (await ref.get()).exists
  await ref.set(asFields(row), { merge: true })
  return { id, action: exists ? "updated" : "created" }
}

init()
console.log(`Seeding ${POOL.length} demo candidates into pa-users...`)
let created = 0, updated = 0, failed = 0
for (const row of POOL) {
  const r = await upsertOne(row)
  console.log(`  ${r.action.padEnd(8)} ${r.id}` + (r.error ? ` <- ${r.error}` : ""))
  if (r.action === "created") created++
  else if (r.action === "updated") updated++
  else failed++
}
console.log(`\nDone. created=${created} updated=${updated} failed=${failed}`)
process.exit(failed > 0 ? 1 : 0)
