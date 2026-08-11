/**
 * Hand-probe of the Coresignal COMPANY endpoints — is it worth paying for?
 *
 * Two questions:
 *   A) `company_multi_source/collect/{id}` on ids we ALREADY hold free from the
 *      employee payload — does it return MORE than the experience entry embeds
 *      (funding rounds / stage / description), especially for a brand-new startup
 *      whose embedded company_* fields are all null?
 *   B) `company_multi_source/search/es_dsl` by NAME / DOMAIN — can we resolve the
 *      founders who have no company_id, and can we do it without matching the
 *      wrong "Axiom"?
 *
 * Deliberately small (a couple dozen calls). Run:
 *   CORESIGNAL_API_KEY=... node --import tsx apps/functions/scripts/probe-coresignal-company.ts
 */
import { CORESIGNAL_DEFAULT_BASE_URL } from "@pa/external-supply"

const KEY = process.env.CORESIGNAL_API_KEY!
if (!KEY) { console.error("CORESIGNAL_API_KEY missing"); process.exit(2) }

let calls = 0

async function collect(id: number): Promise<any> {
  calls++
  const res = await fetch(`${CORESIGNAL_DEFAULT_BASE_URL}/company_multi_source/collect/${id}`, {
    headers: { "Content-Type": "application/json", apikey: KEY },
  })
  if (!res.ok) return { __error: res.status, body: (await res.text()).slice(0, 200) }
  return res.json()
}

async function search(query: Record<string, unknown>, index = "company_multi_source"): Promise<any> {
  calls++
  const res = await fetch(`${CORESIGNAL_DEFAULT_BASE_URL}/${index}/search/es_dsl`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: KEY },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) return { __error: res.status, body: (await res.text()).slice(0, 300) }
  return res.json()
}

/** Only the fields that answer "what is this company: stage / size / what / funding". */
function digest(c: any) {
  if (!c || c.__error) return c
  const pick = (k: string) => c[k]
  return {
    id: c.id,
    company_name: pick("company_name"),
    website: pick("website"),
    linkedin_url: pick("linkedin_url") ?? pick("canonical_linkedin_url"),
    industry: pick("industry"),
    founded_year: pick("founded_year"),
    size_range: pick("size_range"),
    employees_count: pick("employees_count"),
    hq: [pick("hq_city"), pick("hq_country")].filter(Boolean).join(", "),
    type: pick("type") ?? pick("company_type"),
    description: typeof c.description === "string" ? c.description.slice(0, 260) : c.description,
    categories_and_keywords: pick("categories_and_keywords"),
    // funding — the "seriesABCD" question
    last_funding_round_date: pick("last_funding_round_date"),
    last_funding_round_amount_raised: pick("last_funding_round_amount_raised"),
    last_funding_round_type: pick("last_funding_round_type"),
    total_funding_amount_raised: pick("total_funding_amount_raised"),
    funding_rounds: pick("funding_rounds"),
    num_funding_rounds: pick("num_funding_rounds"),
    is_b2b: pick("is_b2b"),
    active_job_postings_count: pick("active_job_postings_count"),
  }
}

async function main() {
  const mode = process.argv[2] ?? "all"

  if (mode === "all" || mode === "collect") {
    console.log("\n############ A) collect/{id} on ids we already have FREE ############")
    const targets: Array<[string, number, string]> = [
      ["Reeltors AI", 101324989, "brand-new, ALL embedded company_* fields null"],
      ["Centralize (YC W24)", 94733905, "YC-tagged, embedded fields null"],
      ["GRAI Clinic", 101005426, "brand-new, embedded null"],
      ["xPay (YC W24)", 94803881, "embedded HAS industry — does collect add funding?"],
      ["Pipeshift (YC S24)", 96632120, "known YC AI-infra, raised seed"],
      ["AgentMail (YC S25)", 98243589, "YC S25"],
      ["Clad Labs (YC F25)", 99181669, "YC F25"],
      ["Stealth", 83805468, "placeholder company — expect junk"],
    ]
    for (const [name, id, why] of targets) {
      const c = await collect(id)
      console.log(`\n--- ${name}  id=${id}   (${why})`)
      console.log(JSON.stringify(digest(c), null, 2))
      if (!c.__error && process.argv.includes("--allkeys")) {
        console.log("  ALL non-null keys:", Object.entries(c).filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)).map(([k]) => k).join(", "))
      }
    }
  }

  if (mode === "all" || mode === "search") {
    console.log("\n\n############ B) search by name / domain ############")
    const names = ["Instacart", "Phantm", "Songscription", "Sentia Labs", "Reeltors AI", "AgentMail", "Axiom", "Exa", "VibeWrite", "AcreScope"]
    for (const n of names) {
      const r = await search({ match_phrase: { company_name: n } })
      const ids = Array.isArray(r) ? r : (r.data ?? r)
      console.log(`  name="${n}" -> ${r.__error ? `ERROR ${r.__error} ${r.body}` : `${Array.isArray(ids) ? ids.length : "?"} hits  ${JSON.stringify(Array.isArray(ids) ? ids.slice(0, 6) : ids).slice(0, 200)}`}`)
    }
    console.log("\n  -- by website domain --")
    for (const d of ["instacart.com", "phantm.co", "songscription.ai", "agentmail.to"]) {
      const r = await search({ match_phrase: { website: d } })
      const ids = Array.isArray(r) ? r : (r.data ?? r)
      console.log(`  website="${d}" -> ${r.__error ? `ERROR ${r.__error} ${r.body}` : `${Array.isArray(ids) ? ids.length : "?"} hits ${JSON.stringify(Array.isArray(ids) ? ids.slice(0, 4) : ids).slice(0, 160)}`}`)
    }
  }

  console.log(`\n[probe] API calls used: ${calls}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
