/**
 * Resolve what the YC-cohort founders' COMPANIES actually are, and write the answer
 * to `pa-external-candidate-records/{id}.companyProfile`.
 *
 * Two passes:
 *   FREE  — everything the cached Coresignal employee payload (`pa-coresignal-cache`)
 *           already embeds on the founder's ACTIVE experience row, plus the "(YC W24)"
 *           tag and the internal `pa-companies` library. Zero API calls.
 *   PAID  — (--paid) Coresignal `company_multi_source`. Every search carries a handle
 *           for THAT founder's company, never a bare name: website_domain →
 *           canonical_linkedin_url → name+city → name-only (last resort, 1 hit only).
 *           Results cached in `pa-coresignal-company-cache` so re-runs are free.
 *
 * Absolute rule: cannot disambiguate → write nothing but an explicit `unknownReason`.
 * A written "unknown" is a fact; a silent absence is indistinguishable from a bug.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... CORESIGNAL_API_KEY=...
 *   node --import tsx apps/functions/scripts/yc-company-resolve.ts [--paid] [--apply] [--limit N]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import {
  FOUNDER_RE, normCompanyName, namesAgree, domainOf,
  trustedCompanyContext, composeCompanyProfile,
} from "../src/yc-company-lib.js"

const require = createRequire("/Users/adam/Desktop/WeKruit/wekruit-pa/.claude/worktrees/serene-diffie-15b15a/apps/functions/")
const admin = require("firebase-admin")

type Rec = Record<string, any>
const COHORT = "yc_startup_school_2026"
const BASE = "https://api.coresignal.com/cdapi/v2"
const COMPANY_CACHE = "pa-coresignal-company-cache"

const PAID = process.argv.includes("--paid")
const APPLY = process.argv.includes("--apply")
const LIMIT = process.argv.indexOf("--limit") > 0 ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : Infinity

let apiCalls = 0
let db: any

// ---------------------------------------------------------------------------
// Coresignal company API, cached through Firestore (re-runs cost nothing).
// ---------------------------------------------------------------------------

async function cached<T>(key: string, miss: () => Promise<T>): Promise<T> {
  const ref = db.collection(COMPANY_CACHE).doc(key)
  const snap = await ref.get()
  if (snap.exists) return snap.data().value as T
  const value = await miss()
  await ref.set({ value, fetchedAt: new Date().toISOString() })
  return value
}

/**
 * collect/{id} → the company record, or `{__status:404}` when it isn't in the index.
 * `cacheOnly` reads the Firestore cache and NEVER calls the API — that's how the free pass
 * keeps the real funding rounds we already paid for instead of overwriting them with null.
 */
async function collectCompany(id: number, cacheOnly = false): Promise<Rec> {
  if (cacheOnly) {
    const snap = await db.collection(COMPANY_CACHE).doc(`id-${id}`).get()
    return snap.exists ? (snap.data().value as Rec) : { __status: "cache_miss" }
  }
  return cached(`id-${id}`, async () => {
    apiCalls++
    const res = await fetch(`${BASE}/company_multi_source/collect/${id}`, {
      headers: { "Content-Type": "application/json", apikey: process.env.CORESIGNAL_API_KEY! },
    })
    if (res.status === 404) return { __status: 404 }
    if (!res.ok) return { __status: res.status, __body: (await res.text()).slice(0, 200) }
    return await res.json()
  })
}

/** ES-DSL search → company ids. Cached by the query itself. */
async function searchCompany(query: Rec, key: string): Promise<number[]> {
  return cached(`q-${key}`, async () => {
    apiCalls++
    const res = await fetch(`${BASE}/company_multi_source/search/es_dsl`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: process.env.CORESIGNAL_API_KEY! },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) return []
    const d = await res.json()
    const arr = Array.isArray(d) ? d : (d?.data ?? [])
    return Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === "number") : []
  })
}

// ---------------------------------------------------------------------------
// The resolution ladder. Every rung carries a handle specific to THIS founder's
// company; a bare name is the last resort and only when it is unambiguous.
// ---------------------------------------------------------------------------

type Resolved = { company: Rec; via: string } | { company: null; reason: string }

async function resolveCompany(entry: Rec | null, statedName: string | null, city: string | null): Promise<Resolved> {
  const wantName = entry?.company_name ?? statedName

  // 1. company_id off the trusted ACTIVE row — already identity-verified, no name check needed.
  if (entry?.company_id) {
    const c = await collectCompany(entry.company_id)
    if (!c.__status) return { company: c, via: "company_id" }
    if (c.__status !== 404) return { company: null, reason: `api_error_${c.__status}` }
    // 404 → fall through; the id exists on LinkedIn but not in the company index.
  }

  // 2. website domain — exact (POC: agentmail.to → 1 hit).
  const domain = domainOf(entry?.company_website)
  if (domain) {
    const ids = await searchCompany({ match_phrase: { website_domain: domain } }, `domain-${domain}`)
    for (const id of ids.slice(0, 3)) {
      const c = await collectCompany(id)
      if (!c.__status) return { company: c, via: "website_domain" }
    }
  }

  // 3. company LinkedIn URL — exact.
  if (entry?.company_linkedin_url) {
    const u = String(entry.company_linkedin_url)
    const ids = await searchCompany({ match_phrase: { canonical_linkedin_url: u } }, `li-${u.split("/").filter(Boolean).pop()}`)
    for (const id of ids.slice(0, 3)) {
      const c = await collectCompany(id)
      if (!c.__status) return { company: c, via: "company_linkedin_url" }
    }
  }

  if (!wantName) return { company: null, reason: "no_company_handle" }

  // 4. name + city. Narrow, and every hit must still pass the name check.
  if (city) {
    const ids = await searchCompany(
      { bool: { must: [{ match_phrase: { company_name: wantName } }, { match_phrase: { hq_city: city } }] } },
      `name-city-${normCompanyName(wantName)}-${normCompanyName(city)}`,
    )
    for (const id of ids.slice(0, 5)) {
      const c = await collectCompany(id)
      if (!c.__status && namesAgree(c.company_name, wantName)) return { company: c, via: "name_plus_city" }
    }
  }

  // 5. Name alone — last resort. Only when the index returns a handful AND the name
  // verifies exactly. "Axiom" returns 1000 hits; that must resolve to nothing.
  const ids = await searchCompany({ match_phrase: { company_name: wantName } }, `name-${normCompanyName(wantName)}`)
  if (!ids.length) return { company: null, reason: "absent_from_index" }
  if (ids.length > 5) return { company: null, reason: `ambiguous_name_${ids.length}_hits` }
  for (const id of ids) {
    const c = await collectCompany(id)
    if (!c.__status && normCompanyName(c.company_name ?? "") === normCompanyName(wantName)) {
      return { company: c, via: "name_exact" }
    }
  }
  return { company: null, reason: "no_name_verified_match" }
}

const clean = <T extends Rec>(o: T): T => JSON.parse(JSON.stringify(o, (_k, v) => (v === undefined ? null : v)))

async function main() {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8"))),
  })
  db = admin.firestore()
  if (PAID && !process.env.CORESIGNAL_API_KEY) { console.error("--paid needs CORESIGNAL_API_KEY"); process.exit(2) }

  const { coresignalCacheKey } = await import("../src/lib/coresignal-cache.js")
  const snap = await db.collection("pa-external-candidate-records").where("enrichment.cohort", "==", COHORT).get()
  const rows: Rec[] = snap.docs.map((d: any) => ({ id: d.id, ...d.data() })).filter((r: Rec) => r.canonicalLinkedInUrl)

  const cache = new Map<string, Rec>()
  const keys = rows.map((r) => coresignalCacheKey(r.canonicalLinkedInUrl))
  for (let i = 0; i < keys.length; i += 300) {
    const got = await db.getAll(...keys.slice(i, i + 300).map((k: string) => db.collection("pa-coresignal-cache").doc(k)))
    for (const g of got) if (g.exists) cache.set(g.id, g.data())
  }

  const lib = new Map<string, Rec>()
  for (const d of (await db.collection("pa-companies").get()).docs) {
    const c = d.data()
    const n = normCompanyName(String(c.name ?? c.companyName ?? d.id))
    if (n) lib.set(n, c)
  }

  // WHOLE COHORT, not just founders. A non-founder's employer is the easy case (Tesla, Stripe,
  // Adobe — real Coresignal records), and "anyone at an early-stage startup" is unanswerable for
  // 4 of every 5 people in the pool while only founders carry a companyProfile.
  const founders = rows
    .map((r) => {
      const emp = cache.get(coresignalCacheKey(r.canonicalLinkedInUrl))?.employee
      const title = String(r.currentTitle ?? emp?.active_experience_title ?? emp?.headline ?? "")
      return { r, emp, title, isFounder: FOUNDER_RE.test(title) }
    })
    .filter((f) => f.emp)
    .slice(0, LIMIT)

  console.log(`[resolve] cohort=${rows.length} cacheHits=${cache.size} toProcess=${founders.length} (founders=${founders.filter((f) => f.isFounder).length}) paid=${PAID} apply=${APPLY}`)

  const profiles: Rec[] = []
  let n = 0
  for (const f of founders) {
    n++
    const stated: string | null = f.r.currentCompany && f.r.currentCompany !== "null" ? String(f.r.currentCompany) : null
    // The trust gate + batch tag + "is there even a company here" judgement. SHARED with the live
    // scanner path (src/yc-pool-sync.ts) — the only thing this script adds is the search ladder.
    const ctx = trustedCompanyContext(f.emp, stated, f.title)
    const e = ctx.entry
    const libHit = stated && !ctx.resolveNote ? lib.get(normCompanyName(stated)) : undefined

    let company: Rec | null = null
    let via: string | null = null
    // Why we could not enrich further. NOT the same as "unknown company" — a founder
    // whose company is absent from Coresignal's index still has a name and their own
    // description from the free pass.
    let resolveNote: string | null = null

    // FREE pass: reuse any company record already in the cache. Zero API calls, and it keeps
    // the real funding rounds already fetched instead of overwriting them with null.
    if (!PAID && !ctx.resolveNote && e?.company_id) {
      const c = await collectCompany(e.company_id, true)
      if (!c.__status) { company = c; via = "company_cache" }
    }

    if (PAID && !ctx.resolveNote) {
      const city = f.emp?.location_city ?? null
      const res = await resolveCompany(e, stated, city)
      if (res.company) {
        via = res.via
        company = res.company
      } else {
        resolveNote = res.reason
      }
    }

    const merged = composeCompanyProfile({
      emp: f.emp,
      ctx,
      statedCompany: stated,
      title: f.title,
      company,
      resolvedVia: via,
      resolveNote,
      libStage: libHit?.companyStage ?? null,
      libTags: libHit?.companyTags ?? null,
      nowIso: new Date().toISOString(),
    })

    profiles.push({ recordId: f.r.id, name: f.r.fullName ?? f.emp?.full_name, title: f.title, isFounder: ctx.isFounder, personLinkedin: f.r.canonicalLinkedInUrl, ...merged })
    if (n % 20 === 0) console.log(`  ...${n}/${founders.length} apiCalls=${apiCalls}`)
  }

  // ---- write ----
  if (APPLY) {
    for (let i = 0; i < profiles.length; i += 400) {
      const batch = db.batch()
      for (const p of profiles.slice(i, i + 400)) {
        const { recordId, name, title, personLinkedin, isFounder, ...profile } = p
        batch.set(db.collection("pa-external-candidate-records").doc(recordId), { companyProfile: clean(profile) }, { merge: true })
      }
      await batch.commit()
    }
    console.log(`[resolve] WROTE companyProfile on ${profiles.length} records`)
  } else {
    console.log("[resolve] DRY RUN — pass --apply to write")
  }

  // ---- report ----
  const t = profiles.length
  const pct = (p: (x: Rec) => boolean) => { const c = profiles.filter(p).length; return `${String(c).padStart(3)}/${t}  ${String(Math.round(c / t * 100)).padStart(3)}%` }
  console.log(`\n=== COVERAGE (founders n=${t}, paid=${PAID}, apiCalls=${apiCalls}) ===`)
  console.log(`  what they do        ${pct((p) => !!p.whatTheyDo)}`)
  console.log(`  industry            ${pct((p) => !!p.industry)}`)
  console.log(`  size range          ${pct((p) => !!p.sizeRange)}`)
  console.log(`  employees count     ${pct((p) => !!p.employeesCount)}`)
  console.log(`  founded year        ${pct((p) => !!p.foundedYear)}`)
  console.log(`  website             ${pct((p) => !!p.website)}`)
  console.log(`  STAGE (round type)  ${pct((p) => !!p.stage)}`)
  console.log(`  any funding signal  ${pct((p) => !!(p.stage || p.lastFundingDate))}`)
  console.log(`  investors named     ${pct((p) => p.investors?.length)}`)
  console.log(`  YC batch            ${pct((p) => !!p.ycBatch)}`)
  console.log(`  UNKNOWN             ${pct((p) => !!p.unknownReason)}`)

  const byVia: Record<string, number> = {}
  for (const p of profiles) byVia[p.resolvedVia ?? "none"] = (byVia[p.resolvedVia ?? "none"] ?? 0) + 1
  console.log("\n  resolved via:", JSON.stringify(byVia))
  const byReason: Record<string, number> = {}
  for (const p of profiles.filter((x) => x.unknownReason)) byReason[p.unknownReason] = (byReason[p.unknownReason] ?? 0) + 1
  console.log("  unknown reasons:", JSON.stringify(byReason))

  console.log("\n=== UNKNOWN LIST ===")
  for (const p of profiles.filter((x) => x.unknownReason)) console.log(`  ${p.name} | stated="${p.statedCompany}" | ${p.unknownReason} | trust=${p.trustReason}`)

  const j = process.argv.indexOf("--json")
  if (j > 0) { writeFileSync(process.argv[j + 1], JSON.stringify(profiles, null, 2)); console.log(`\nwrote -> ${process.argv[j + 1]}`) }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
