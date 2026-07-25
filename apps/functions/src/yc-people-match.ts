/**
 * yc-people-match.ts — people↔people matching for an event cohort (Adam 2026-07-25).
 *
 * WHY THIS EXISTS: Claire promises every YC Startup School scanner she'll match them with "the
 * right Startup School people", but nothing produced that match. The two answers she collects
 * (`ycIntake.building` / `wantsToMeet`) were stored and never consumed by any matcher, and every
 * matcher in the repo is job-centric.
 *
 * SHAPE: modelled on `apps/job-rec/src/reverse-match.ts`, which is already person-pool cosine
 * matching (embed a query → load a pool → cosine → rerank → topK). We reuse its *components* rather
 * than wrapping `runReverseMatch` itself, because that driver internally calls
 * `synthesizeJobFromJd` → `applyHardFilters` (visa / location / seniority / yoe). Those are job
 * semantics and would silently drop attendees — an investor "needing sponsorship" is meaningless.
 *
 * NOT PURE SEMANTIC. Cosine answers "who is like me / building something similar", but the asks
 * people actually make are mixed:
 *     "people doing fintech"        → facet   (industrySector)
 *     "who else does ML"            → facet   (skills)
 *     "anyone from my school"       → RELATIONAL exact match against the ASKER's own schools
 *     "who's built something like mine" → semantic
 * So: structured facets narrow the pool, semantics rank inside it.
 *
 * ONE-DIRECTIONAL by design. The cohort never told us who *they* want to meet and never opted in,
 * so only the scanner receives recommendations; nobody in the pool is contacted.
 */
import type { Firestore } from "firebase-admin/firestore"
// Query-side parity with the stored, canonicalized skill form (see passesFacets).
import { normalizeSkillToken } from "./skill-token.js"

export const YC_COHORT_2026 = "yc_startup_school_2026"

/** A person in the matchable pool, flattened from an external-candidate record. */
export interface PeoplePoolMember {
  recordId: string
  name: string | null
  linkedinUrl: string | null
  currentTitle: string | null
  currentCompany: string | null
  location: string | null
  schools: string[]
  majors: string[]
  companies: string[]
  skills: string[]
  /** Text used for the semantic stage. */
  matchText: string
  embedding?: number[] | null
  /** "Likely Match" | "First Result" | "Needs Review" | … — the sheet's own confidence. */
  matchStatus: string | null
}

/** Facets the agent may set. Every one is optional; set ones are AND-ed. */
export interface YcPeopleMatchFilters {
  /** Free-text semantic steer. Falls back to the asker's own intake answers. */
  query?: string
  skills?: string[]
  industrySector?: string[]
  roleFunction?: string[]
  companies?: string[]
  schools?: string[]
  major?: string[]
  location?: string[]
  /** Relational — resolved from the ASKER's own profile, never guessed by the model. */
  sameSchool?: boolean
  sameCompany?: boolean
  sameMajor?: boolean
}

export interface YcPeopleMatchResult {
  recordId: string
  name: string | null
  linkedinUrl: string | null
  title: string | null
  company: string | null
  location: string | null
  score: number
  /** Human-readable "why" naming WHICH signal matched. */
  reason: string
  /** True when the facet filter yielded too few and this row came from the widened pool. */
  relaxed: boolean
  matchStatus: string | null
}

export interface YcPeopleMatchOutput {
  results: YcPeopleMatchResult[]
  poolSize: number
  /** How many survived the facet stage — surfaced so Claire can be honest about a narrow ask. */
  facetMatched: number
  /** True when we widened because the facets were too narrow. */
  didRelax: boolean
  reason?: "no_intake" | "empty_pool" | "embed_failed"
}

// ---------------------------------------------------------------------------
// Step 3 — the people projection
// ---------------------------------------------------------------------------

const MAX_TEXT = 8000

/**
 * What the person's company actually DOES — derived once at index time by
 * `scripts/describe-yc-attendees.ts` (gpt-5.4-nano) and cached on the record.
 * A profile says "Software Engineer @ Faire", never "two-sided marketplace", so business-MODEL
 * queries had no surface to bind to. This gives them one.
 */
export interface BusinessDescriptor {
  /** e.g. ["two_sided_marketplace", "ecommerce"] */
  businessModel: string[]
  /** e.g. ["wholesale retail", "logistics"] */
  domain: string[]
  /** One sentence: product category + who buys it. */
  whatTheyBuild: string
  generatedAt?: string
}

/** Flatten a descriptor into embeddable prose. Empty string when absent. */
function descriptorText(b: BusinessDescriptor | null | undefined): string {
  if (!b) return ""
  const parts = [
    (b.businessModel ?? []).map((x) => x.replace(/_/g, " ")).join(", "),
    (b.domain ?? []).join(", "),
    typeof b.whatTheyBuild === "string" ? b.whatTheyBuild : "",
  ].filter((x) => x && x.trim().length > 0)
  return parts.join(". ")
}

/**
 * The business-model tokens, repeated, as the FIRST line of the projection.
 *
 * Repetition is not decoration: a profile is ~1500 tokens and the descriptor ~40, so folding it in
 * once only moves "marketplace" precision@8 from 0.13 → 0.38. Repeating the model tokens at the
 * head takes it to 0.88 (measured over the 988-person cohort, 2026-07-25) — the abstraction has to
 * hold real mass in a mean-pooled vector or the profile prose drowns it.
 *
 * ponytail: crude term weighting. If this ever needs to be finer, the measured next step is a
 * SEPARATE descriptor-only vector scored alongside the profile vector (precision@8 0.97) — but that
 * is a second field plus a scoring change in the matcher, so not until this stops being enough.
 */
const MODEL_REPEATS = 3

function businessModelHead(b: BusinessDescriptor | null | undefined): string {
  const models = (b?.businessModel ?? []).map((x) => x.replace(/_/g, " ")).filter((x) => x.trim())
  if (models.length === 0) return ""
  return `${models.join(", ")}. `.repeat(MODEL_REPEATS).trim()
}

/**
 * Build the text we embed for people matching.
 *
 * `synthesizeCvSummaryText` (lib/embeddings.ts:68) already contains skills / experience / education
 * / industry / location — nothing is "lost" by not using it. The difference is WEIGHTING: it is a
 * job projection (skills prominent, top-3 experiences, 25 skills), so two people who both list
 * `Python, React, AWS` score as similar even when one does biotech and the other games. For "should
 * I meet this person" the dominant signal is what they're building and in what domain, so:
 *   - current role first (strongest),
 *   - all prior experience (not truncated to 3 — serial founders lose their early companies),
 *   - skills capped at 12 (not 25) so they cannot drown the domain signal,
 *   - education last.
 */
export function synthesizePeopleMatchText(p: {
  name?: string | null
  currentTitle?: string | null
  currentCompany?: string | null
  location?: string | null
  experience?: Array<{ title?: string | null; company?: string | null; description?: string | null }>
  education?: Array<{ school?: string | null; degree?: string | null }>
  skills?: string[]
  industry?: string[]
  /** The person's own words — beats any inferred profile. Only the asker has these. */
  intent?: string | null
  /** Index-time company knowledge (business model / domain). Absent for the asker. */
  businessDescriptor?: BusinessDescriptor | null
}): string {
  const lines: string[] = []
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "")

  // 0. Business model, weighted to the head — the only surface an abstract query
  // ("marketplace", "B2B SaaS") can bind to. Nobody writes it on their profile.
  const head = businessModelHead(p.businessDescriptor)
  if (head) lines.push(head)

  // 1. What they do NOW — the single strongest signal for "worth meeting".
  const title = s(p.currentTitle)
  const company = s(p.currentCompany)
  if (title || company) lines.push(title && company ? `${title} @ ${company}` : title || company)

  // 1b. What that company actually does — sits right behind the role so the abstraction
  // ("marketplace", "b2b saas") is near the top of the projection, where cosine weights it.
  const bd = descriptorText(p.businessDescriptor)
  if (bd) lines.push(bd)

  // 2. Domain.
  const industry = (p.industry ?? []).filter((x) => s(x))
  if (industry.length > 0) lines.push(industry.join(", "))

  // 3. Stated intent — what they SAY they're building / who they want to meet.
  const intent = s(p.intent)
  if (intent) lines.push(intent)

  // 4. Full experience timeline (title @ company + description), not truncated.
  const exp: string[] = []
  for (const e of p.experience ?? []) {
    const t = s(e?.title)
    const c = s(e?.company)
    const d = s(e?.description)
    const head = t && c ? `${t} @ ${c}` : t || c
    if (!head && !d) continue
    exp.push(d ? `${head}\n${d}` : head)
  }
  if (exp.length > 0) lines.push(exp.join("\n"))

  // 5. Skills, capped low on purpose.
  const skills = dedupeLower(p.skills ?? []).slice(0, 12)
  if (skills.length > 0) lines.push(skills.join(", "))

  // 6. Education last — weakest signal for "should we meet".
  const edu = (p.education ?? [])
    .map((e) => {
      const d = s(e?.degree)
      const sc = s(e?.school)
      return d && sc ? `${d} @ ${sc}` : d || sc
    })
    .filter((x) => x.length > 0)
  if (edu.length > 0) lines.push(edu.join("\n"))

  const loc = s(p.location)
  if (loc) lines.push(loc)

  return lines.join("\n").trim().slice(0, MAX_TEXT)
}

function dedupeLower(xs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    const k = String(x ?? "").trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(String(x).trim())
  }
  return out
}

// ---------------------------------------------------------------------------
// Step 4 — hybrid retrieval
// ---------------------------------------------------------------------------

/** Loose containment match — "Berkeley" should hit "University of California, Berkeley". */
/** Escape a user/model-supplied token before it goes into a RegExp. */
function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Shortest haystack token allowed to substring-match a longer query. */
const MIN_REVERSE_MATCH = 4

function looseHit(haystack: string[], needles: string[]): boolean {
  if (needles.length === 0) return true
  const hay = haystack.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)
  return needles.some((n) => {
    const q = n.trim().toLowerCase()
    if (!q) return false
    return hay.some((h) => {
      // Forward: the member's value contains the query. "Berkeley" hits
      // "University of California, Berkeley" — this is the case the facet exists for.
      // WORD BOUNDARY for short queries: a bare "rl" was matching "world" / "early" and
      // returned 63 irrelevant people (measured 2026-07-25). Long queries keep plain
      // containment so "machine learn" still hits "machine learning".
      if (q.length < MIN_REVERSE_MATCH) {
        if (new RegExp(`\\b${escapeRe(q)}\\b`).test(h)) return true
      } else if (h.includes(q)) return true
      // Reverse: the member's value is a substring of the query. Needed for
      // "Stanford University" (stored) vs "Stanford" (asked)... but it is also how a
      // 1-2 char token becomes a wildcard: a member carrying the skill "c" matched EVERY
      // query containing the letter c, and "chi" matched "machine learning" (found by the
      // skills audit, 2026-07-25). Require a real token before allowing the reverse
      // direction, and require a word boundary so "art" cannot hit "smart".
      if (h.length < MIN_REVERSE_MATCH) return false
      return new RegExp(`\\b${escapeRe(h)}\\b`).test(q)
    })
  })
}

/** Apply every set facet. All AND-ed; an unset facet is a pass. */
export function passesFacets(
  m: PeoplePoolMember,
  f: YcPeopleMatchFilters,
  asker: { schools: string[]; companies: string[]; majors: string[] },
): boolean {
  // QUERY-SIDE PARITY: stored skills are canonicalized with abbreviations EXPANDED
  // (`ml` → `machine learning`, `k8s` → `kubernetes`), so a raw "ML" from the model would no
  // longer substring-hit anything. Normalize the query the same way before comparing; keep the
  // original too, so an unrecognized token still matches literally.
  if (f.skills?.length) {
    const needles = f.skills.flatMap((s) => {
      const norm = normalizeSkillToken(s)
      return norm && norm !== s.trim().toLowerCase() ? [s, norm] : [s]
    })
    if (!looseHit(m.skills, needles)) return false
  }
  if (f.schools?.length && !looseHit(m.schools, f.schools)) return false
  if (f.companies?.length && !looseHit(m.companies, f.companies)) return false
  if (f.major?.length && !looseHit(m.majors, f.major)) return false
  if (f.location?.length && !looseHit(m.location ? [m.location] : [], f.location)) return false
  if (f.industrySector?.length || f.roleFunction?.length) {
    // Coresignal gives us no canonical industry/roleFunction per attendee, so these degrade to a
    // text probe over title+company rather than silently dropping everyone.
    const probe = [m.currentTitle ?? "", m.currentCompany ?? "", ...m.skills].filter(Boolean)
    const needles = [...(f.industrySector ?? []), ...(f.roleFunction ?? [])].map((x) =>
      x.replace(/_/g, " "),
    )
    if (!looseHit(probe, needles)) return false
  }
  // Relational — resolved from the ASKER, so the model never has to know their school name.
  if (f.sameSchool && !looseHit(m.schools, asker.schools)) return false
  if (f.sameCompany && !looseHit(m.companies, asker.companies)) return false
  if (f.sameMajor && !looseHit(m.majors, asker.majors)) return false
  return true
}

/** Which facet actually produced this hit — so the "why" line is honest, not generic. */
export function explainMatch(
  m: PeoplePoolMember,
  f: YcPeopleMatchFilters,
  asker: { schools: string[]; companies: string[]; majors: string[] },
): string {
  if (f.sameSchool) {
    const hit = m.schools.find((s) => looseHit([s], asker.schools))
    if (hit) return `also went to ${hit}`
  }
  if (f.sameCompany) {
    const hit = m.companies.find((c) => looseHit([c], asker.companies))
    if (hit) return `also worked at ${hit}`
  }
  if (f.schools?.length) {
    const hit = m.schools.find((s) => looseHit([s], f.schools!))
    if (hit) return `${hit}`
  }
  if (f.companies?.length) {
    const hit = m.companies.find((c) => looseHit([c], f.companies!))
    if (hit) return `${hit}`
  }
  if (f.skills?.length) {
    const hit = m.skills.find((s) => looseHit([s], f.skills!))
    if (hit) return `works on ${hit}`
  }
  const t = m.currentTitle ?? ""
  const c = m.currentCompany ?? ""
  return t && c ? `${t} @ ${c}` : t || c || "worth meeting"
}

// ---------------------------------------------------------------------------
// Pool loading
// ---------------------------------------------------------------------------

const RECORDS = "pa-external-candidate-records"

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []
}

/** Flatten an external-candidate record into a matchable pool member. */
export function toPoolMember(recordId: string, d: Record<string, unknown>): PeoplePoolMember {
  const exp = (Array.isArray(d.experience) ? d.experience : []) as Array<Record<string, unknown>>
  const edu = (Array.isArray(d.education) ? d.education : []) as Array<Record<string, unknown>>
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  // PREFER the cleaned list. `sourceTags` is Coresignal's raw inferred+historical skills and is
  // bimodal junk — measured on this cohort: some records carry 81 tokens including "across",
  // "analyst", "analyzing", "ases", "c", while ~half carry ZERO. A `skills:["machine learning"]`
  // facet against the raw field matched 429 of 988 — useless as a filter.
  // `normalizedSkills` (scripts/normalize-yc-skills.ts) drops the noise and backfills the empties
  // from title/experience text. Fall back to the raw field when a record hasn't been normalized yet,
  // so the matcher degrades instead of returning nobody.
  const skills = strArr(d.normalizedSkills).length > 0 ? strArr(d.normalizedSkills) : strArr(d.sourceTags)
  const member: PeoplePoolMember = {
    recordId,
    name: str(d.name),
    linkedinUrl: str(d.canonicalLinkedInUrl),
    currentTitle: str(d.currentTitle),
    currentCompany: str(d.currentCompany),
    location: str(d.location),
    schools: exp.length >= 0 ? edu.map((e) => String(e.school ?? "")).filter(Boolean) : [],
    majors: edu.map((e) => String(e.degree ?? "")).filter(Boolean),
    companies: exp.map((e) => String(e.company ?? "")).filter(Boolean),
    skills,
    matchStatus:
      typeof (d.enrichment as Record<string, unknown> | undefined)?.matchStatus === "string"
        ? String((d.enrichment as Record<string, unknown>).matchStatus)
        : null,
    matchText: "",
    embedding: Array.isArray(d.matchEmbedding) ? (d.matchEmbedding as number[]) : null,
  }
  member.matchText = synthesizePeopleMatchText({
    name: member.name,
    currentTitle: member.currentTitle,
    currentCompany: member.currentCompany,
    location: member.location,
    experience: exp.map((e) => ({
      title: typeof e.title === "string" ? e.title : null,
      company: typeof e.company === "string" ? e.company : null,
      description: typeof e.description === "string" ? e.description : null,
    })),
    education: edu.map((e) => ({
      school: typeof e.school === "string" ? e.school : null,
      degree: typeof e.degree === "string" ? e.degree : null,
    })),
    skills,
    businessDescriptor: (d.businessDescriptor ?? null) as BusinessDescriptor | null,
  })
  return member
}

/** Load a cohort's enriched, matchable members. Cohort is server-side — never model-supplied. */
export async function loadCohortPool(db: Firestore, cohort: string): Promise<PeoplePoolMember[]> {
  const snap = await db.collection(RECORDS).where("enrichment.cohort", "==", cohort).get()
  const out: PeoplePoolMember[] = []
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    // Only rows we actually resolved — an unenriched row has no title/company to match on.
    if (d.coresignalMatch !== "ok") continue
    const m = toPoolMember(doc.id, d)
    if (m.matchText.length < 20) continue
    out.push(m)
  }
  return out
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export interface YcPeopleMatchDeps {
  db: Firestore
  /** Embed arbitrary text (1536-d). Injected so tests never call OpenAI. */
  embed: (text: string) => Promise<number[] | null>
  cosine: (a: readonly number[], b: readonly number[]) => number
  /** Already-sent recordIds, so "show me more" never repeats a face. */
  loadAlreadySent?: (db: Firestore, userId: string, cohort: string) => Promise<Set<string>>
  log?: (event: string, payload?: Record<string, unknown>) => void
}

/** Below this, a facet ask is treated as too narrow and we widen — visibly, never silently. */
const MIN_FACET_RESULTS = 3

export async function runYcPeopleMatch(
  input: { userId: string; cohort?: string; limit?: number; filters?: YcPeopleMatchFilters },
  deps: YcPeopleMatchDeps,
): Promise<YcPeopleMatchOutput> {
  const cohort = input.cohort ?? YC_COHORT_2026
  const limit = Math.max(1, Math.min(input.limit ?? 5, 20))
  const f = input.filters ?? {}
  const log = deps.log ?? (() => {})

  // 1. The asker.
  const userSnap = await deps.db.collection("pa-users").doc(input.userId).get()
  const u = (userSnap.data() ?? {}) as Record<string, unknown>
  const intake = (u.ycIntake ?? {}) as { building?: unknown; wantsToMeet?: unknown }
  const building = typeof intake.building === "string" ? intake.building : ""
  const wantsToMeet = typeof intake.wantsToMeet === "string" ? intake.wantsToMeet : ""

  const highlights = (Array.isArray(u.experienceHighlights) ? u.experienceHighlights : []) as Array<
    Record<string, unknown>
  >
  const asker = {
    schools: strArr((u.tags as Record<string, unknown> | undefined)?.schools).concat(
      highlights.map((h) => String(h.school ?? "")).filter(Boolean),
    ),
    companies: highlights.map((h) => String(h.company ?? "")).filter(Boolean),
    majors: strArr((u.tags as Record<string, unknown> | undefined)?.major),
  }

  // The query: an explicit ask wins; otherwise their own recorded answers. This is the point where
  // "record the user's response AND USE IT" is actually honoured.
  const intent = [building, wantsToMeet].filter(Boolean).join(". ")
  const queryText = (f.query ?? "").trim() || intent
  if (!queryText) {
    log("yc_people_match.no_intake", { userId: input.userId })
    return { results: [], poolSize: 0, facetMatched: 0, didRelax: false, reason: "no_intake" }
  }

  // 2. Pool.
  const pool = await loadCohortPool(deps.db, cohort)
  if (pool.length === 0) {
    return { results: [], poolSize: 0, facetMatched: 0, didRelax: false, reason: "empty_pool" }
  }

  const alreadySent = deps.loadAlreadySent
    ? await deps.loadAlreadySent(deps.db, input.userId, cohort)
    : new Set<string>()
  const fresh = pool.filter((m) => !alreadySent.has(m.recordId))

  // 3. Facet stage.
  const faceted = fresh.filter((m) => passesFacets(m, f, asker))
  const anyFacetSet = Boolean(
    f.skills?.length || f.schools?.length || f.companies?.length || f.major?.length ||
      f.location?.length || f.industrySector?.length || f.roleFunction?.length ||
      f.sameSchool || f.sameCompany || f.sameMajor,
  )
  // Sparse-result rule: never silently substitute. We keep the facet hits FIRST and mark anything
  // from the widened pool `relaxed`, so Claire can say "only 2 from your school — these are close".
  const didRelax = anyFacetSet && faceted.length < MIN_FACET_RESULTS
  const ranked = didRelax ? [...faceted, ...fresh.filter((m) => !faceted.includes(m))] : faceted
  const facetMatched = faceted.length

  // 4. Semantic stage — rank inside whatever survived.
  const askerText = synthesizePeopleMatchText({
    currentTitle: typeof u.recentRoleTitle === "string" ? u.recentRoleTitle : null,
    currentCompany: typeof u.recentCompany === "string" ? u.recentCompany : null,
    experience: highlights.map((h) => ({
      title: typeof h.title === "string" ? h.title : null,
      company: typeof h.company === "string" ? h.company : null,
      description: typeof h.description === "string" ? h.description : null,
    })),
    intent: queryText,
  })
  const qVec = await deps.embed(askerText || queryText)
  if (!qVec) {
    log("yc_people_match.embed_failed", { userId: input.userId })
    return { results: [], poolSize: pool.length, facetMatched, didRelax, reason: "embed_failed" }
  }

  const scored: Array<{ m: PeoplePoolMember; score: number; relaxed: boolean }> = []
  for (const m of ranked) {
    if (!m.embedding || m.embedding.length === 0) continue
    let score = deps.cosine(qVec, m.embedding)
    // A "Needs Review" row is a semi-automatic, possibly-wrong LinkedIn match. Demote rather than
    // drop — the sheet itself warns some rows are the wrong person.
    if (m.matchStatus === "Needs Review") score -= 0.05
    scored.push({ m, score, relaxed: didRelax && !faceted.includes(m) })
  }
  scored.sort((a, b) => {
    // Facet hits always outrank relaxed filler regardless of cosine.
    if (a.relaxed !== b.relaxed) return a.relaxed ? 1 : -1
    return b.score - a.score
  })

  const results = scored.slice(0, limit).map(({ m, score, relaxed }) => ({
    recordId: m.recordId,
    name: m.name,
    linkedinUrl: m.linkedinUrl,
    title: m.currentTitle,
    company: m.currentCompany,
    location: m.location,
    score: Math.round(score * 1000) / 1000,
    reason: explainMatch(m, f, asker),
    relaxed,
    matchStatus: m.matchStatus,
  }))

  log("yc_people_match.ok", {
    userId: input.userId,
    poolSize: pool.length,
    facetMatched,
    didRelax,
    returned: results.length,
  })
  return { results, poolSize: pool.length, facetMatched, didRelax }
}
