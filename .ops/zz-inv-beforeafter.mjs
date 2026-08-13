/**
 * Before/after for real investor asks pulled from live pa-turns toolCall arguments.
 * BEFORE = pre-fix behaviour reconstructed on the SAME pool: personType matched by array
 *          membership (the shipped bug), relax widening to the whole cohort, founder prior on.
 * AFTER  = current code path: slot-0 personType, relax that still honours personType, no founder
 *          prior when a personType was named.
 * Read-only. Never writes, never sends.
 */
import { readFileSync } from "node:fs"
import admin from "firebase-admin"

let raw = readFileSync(".env", "utf8").match(/^FIREBASE_SERVICE_ACCOUNT_JSON=(.*)$/m)[1].trim()
if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))
  raw = raw.slice(1, -1)
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), projectId: "wekruit-5f89b" })
const db = admin.firestore()

const OPENAI_KEY = (readFileSync(".env", "utf8").match(/^(?:PA_OPENAI_AGENT_API_KEY|OPENAI_API_KEY)=(.*)$/m) ?? [])[1]
  ?.trim()
  ?.replace(/^['"]|['"]$/g, "")

async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
  })
  const j = await r.json()
  return j.data?.[0]?.embedding ?? null
}
const cos = (a, b) => {
  let d = 0, x = 0, y = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i] }
  return d / (Math.sqrt(x) * Math.sqrt(y) || 1)
}

// The rollback file records personType as it stood BEFORE the re-label.
const rollbackPath = process.argv[2]
const OLD = new Map()
if (rollbackPath) for (const r of JSON.parse(readFileSync(rollbackPath, "utf8"))) OLD.set(r.id, r.personType)

const snap = await db
  .collection("pa-external-candidate-records")
  .where("enrichment.cohort", "==", "yc_startup_school_2026")
  .get()
const pool = snap.docs.map((d) => {
  const x = d.data()
  return {
    id: d.id,
    name: x.name,
    title: x.currentTitle ?? "",
    company: x.currentCompany ?? "",
    ptNew: x.businessDescriptor?.personType ?? [],
    ptOld: OLD.get(d.id) ?? x.businessDescriptor?.personType ?? [],
    emb: x.matchEmbedding ?? null,
    dEmb: x.descriptorEmbedding ?? null,
    exposure: x.ycExposureCount ?? 0,
    status: x.matchStatus ?? "",
  }
})
console.log(`pool=${pool.length} withEmb=${pool.filter((p) => p.emb?.length).length}`)

const EXPOSURE_STEP = 0.04, EXPOSURE_CAP = 3, FOUNDER_PRIOR = 0.03
const MIN_FACET = 3, REL = 0.88, ABS = 0.42

function run(pool, { pt, query, building, sent, mode }) {
  const old = mode === "before"
  const has = (m) => {
    const list = old ? m.ptOld : m.ptNew
    if (!pt?.length) return true
    return old ? pt.some((x) => list.includes(x)) : pt.some((x) => x === list[0])
  }
  const fresh = pool.filter((m) => !sent.has(m.id))
  const faceted = fresh.filter(has)
  const didRelax = Boolean(pt?.length) && faceted.length < MIN_FACET
  // BEFORE widened to everybody; AFTER keeps personType in the widened pool.
  const widened = didRelax ? fresh.filter((m) => !faceted.includes(m) && (old ? true : has(m))) : []
  return { ranked: [...faceted, ...widened], faceted, didRelax }
}

async function score(ctx, qVec) {
  const out = []
  for (const m of ctx.ranked) {
    if (!m.emb?.length) continue
    let s = cos(qVec, m.emb)
    if (m.dEmb?.length) s = Math.max(s, cos(qVec, m.dEmb))
    if (m.status === "Needs Review") s -= 0.05
    if (m.exposure > 0) s -= EXPOSURE_STEP * Math.min(m.exposure, EXPOSURE_CAP)
    if (ctx.founderPrior && (ctx.old ? m.ptOld : m.ptNew).includes("founder")) s += FOUNDER_PRIOR
    out.push({ m, s, relaxed: ctx.didRelax && !ctx.faceted.includes(m) })
  }
  out.sort((a, b) => (a.relaxed !== b.relaxed ? (a.relaxed ? 1 : -1) : b.s - a.s))
  const best = out[0]?.s ?? 0
  // AFTER only: a personType facet hit is categorical, the cosine floors do not veto it.
  const strong = out.filter(
    (r) => (ctx.facetIsAnswer && !r.relaxed) || (r.s >= best * REL && r.s >= ABS),
  )
  const shortlist = strong.length >= 1 ? strong : out.slice(0, 1)
  // AFTER only: multi-kind asks take turns so the majority kind cannot sweep every slot.
  const kinds = ctx.kinds ?? []
  if (kinds.length < 2) return shortlist.slice(0, 5)
  const taken = new Set()
  const buckets = kinds.map((k) => {
    const b = shortlist.filter((r) => !r.relaxed && !taken.has(r) && (ctx.old ? r.m.ptOld : r.m.ptNew)[0] === k)
    for (const r of b) taken.add(r)
    return b
  })
  const ordered = []
  for (let i = 0; buckets.some((b) => b[i] !== undefined); i++)
    for (const b of buckets) if (b[i]) ordered.push(b[i])
  return [...ordered, ...shortlist.filter((r) => !taken.has(r))].slice(0, 5)
}

const ASKS = JSON.parse(readFileSync(process.argv[3], "utf8"))
for (const a of ASKS) {
  const u = (await db.collection("pa-users").doc(a.uid).get()).data() ?? {}
  const building = u.ycIntake?.building ?? ""
  const sent = new Set() // clean-slate comparison: same starting pool for both arms
  const qText = [a.query || building, a.query ? building : ""].filter(Boolean).join(". ")
  const qVec = await embed(qText)
  console.log(`\n${"=".repeat(100)}\nASK  "${a.inbound}"\n  args query="${a.query}" personType=${JSON.stringify(a.pt)}`)
  for (const mode of ["before", "after"]) {
    const ctx = run(pool, { pt: a.pt, query: a.query, building, sent, mode })
    ctx.old = mode === "before"
    // BEFORE: founder prior always on. AFTER: off whenever a personType was named.
    ctx.founderPrior = mode === "before" ? true : !a.pt?.length
    ctx.facetIsAnswer = mode === "after" && Boolean(a.pt?.length)
    ctx.kinds = mode === "after" ? (a.pt ?? []) : []
    const res = await score(ctx, qVec)
    const nInv = res.filter((r) => (mode === "before" ? r.m.ptOld : r.m.ptNew)[0] === "investor").length
    console.log(`  --- ${mode.toUpperCase()}  facetMatched=${ctx.faceted.length} didRelax=${ctx.didRelax} returned=${res.length} PRIMARY-investor=${nInv}/${res.length}`)
    for (const r of res) {
      const pts = mode === "before" ? r.m.ptOld : r.m.ptNew
      console.log(`      ${pts[0] === "investor" ? "✓" : "✗"} ${r.m.name} — ${r.m.title} @ ${r.m.company}  [${pts.join(",")}] ${r.s.toFixed(3)}${r.relaxed ? " RELAXED" : ""}`)
    }
  }
}
process.exit(0)
