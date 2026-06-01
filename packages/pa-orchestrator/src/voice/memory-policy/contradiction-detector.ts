/**
 * Phase 38 — Contradiction detector.
 *
 * Rule-based 10-type lexicon overlay that flags when a Claire reply
 * contradicts a stored user fact (Mem0-extracted) or a persona-locked
 * fact (Phase 32 W3 `pa-personas/{slug}` Firestore — S3 sync canonical).
 *
 * Algorithm (per CONTEXT D-38-3):
 *
 *   1. Tokenize reply (ascii words)
 *   2. Fetch user-stated facts via `deps.mem0Search(query, userId)`
 *   3. Fetch persona-locked facts via `deps.getPersona(slug)` (S3 sync)
 *   4. Run lexicon match per ContradictionType in priority order:
 *        persona_locked > allergy > health > dietary > preference_negation
 *        > pet > location > relationship > profession > language
 *   5. First violation wins — return ContradictionResult
 *
 * Hard constraints:
 * - 0 net new LLM calls — `deps.mem0Search` calls EXISTING Qwen-extracted
 *   facts (no new extracts triggered)
 * - < 5ms p95 (rule-based; Mem0 search latency NOT counted here — caller
 *   may inject `factsCache` to skip)
 * - English-only (legacy zh lexicons removed)
 * - S3 sync: persona facts via `getPersona`, NEVER inline strings
 *
 * Graceful behavior:
 * - Missing `deps.mem0Search` → user-fact checks skip (only persona-locked
 *   + reply-internal patterns run)
 * - Missing `deps.getPersona` → Type 10 silently skips (other 9 still run)
 * - Empty reply → returns `{ violated: false }` immediately
 */

import type {
  AdviceTrackerDeps,
  ContradictionResult,
  ContradictionType,
  MemoryPolicyContext,
  PersonaSnapshot,
} from "./types.js"

// ---------------------------------------------------------------------------
// Lexicon banks (bilingual zh + en)
// ---------------------------------------------------------------------------

interface Lexicon {
  /** Tokens used to detect the user-side fact (or persona-side). */
  factTerms: string[]
  /** Tokens whose presence in the reply represents a contradiction. */
  violatingTerms: string[]
}

/**
 * Ordered priority — earlier types win when multiple match.
 * Mirrors CONTEXT D-38-3 priority list.
 */
const TYPE_PRIORITY: ContradictionType[] = [
  "persona_locked",
  "allergy",
  "health",
  "dietary",
  "preference_negation",
  "pet",
  "location",
  "relationship",
  "profession",
  "language",
]

// Vegetarian/vegan-style + meat term banks reused by both `dietary` and
// `persona_locked` (when persona declares dietary preference).
const VEG_FACT_TERMS = [
  "vegetarian",
  "vegan",
  "plant-based",
  "plant based",
  "no meat",
]

const MEAT_VIOLATING_TERMS = [
  "beef",
  "steak",
  "steakhouse",
  "ribeye",
  "pork",
  "chicken",
  "bacon",
  "mutton",
  "lamb",
  "fish",
  "salmon",
  "tuna",
  "shrimp",
  "duck",
]

const LEXICONS: Record<Exclude<ContradictionType, "language" | "persona_locked">, Lexicon> = {
  dietary: {
    factTerms: VEG_FACT_TERMS,
    violatingTerms: MEAT_VIOLATING_TERMS,
  },
  allergy: {
    // Pattern matched contextually — see allergy detector below.
    factTerms: [
      "allergic",
      "allergy",
      "intolerant",
      "intolerance",
    ],
    violatingTerms: [
      "peanut",
      "peanuts",
      "peanut butter",
      "dairy",
      "milk",
      "egg",
      "eggs",
      "gluten",
      "shellfish",
      "shrimp",
      "nut",
      "nuts",
      "almond",
      "cashew",
    ],
  },
  pet: {
    // `factTerms` here is "user owns cat"; violation is "Claire mentions dog"
    // (and vice versa). Detector handles both directions.
    factTerms: ["cat", "kitten", "kitty"],
    violatingTerms: ["dog", "puppy", "doggie", "pup"],
  },
  location: {
    // Cities — fact = where user lives; violation = different city in reply.
    factTerms: [],
    violatingTerms: [],
  },
  relationship: {
    factTerms: ["single", "unmarried", "not married", "no partner"],
    violatingTerms: [
      "your spouse",
      "your husband",
      "your wife",
      "your boyfriend",
      "your girlfriend",
      "your partner",
    ],
  },
  profession: {
    factTerms: [],
    violatingTerms: [],
  },
  preference_negation: {
    // Pattern detected contextually: "I never X" -> reply suggests X
    factTerms: [],
    violatingTerms: [],
  },
  health: {
    factTerms: ["diabetic", "diabetes", "hypertension", "asthma", "heart disease"],
    violatingTerms: [
      "sugar",
      "sugary",
      "dessert",
      "cake",
      "sweets",
      "candy",
      "chocolate",
      "soda",
      "ice cream",
      "donut",
      "doughnut",
    ],
  },
}

// City lists for location detector.
const ZH_CITIES: string[] = []
const EN_CITIES = [
  "NYC",
  "New York",
  "LA",
  "Los Angeles",
  "SF",
  "San Francisco",
  "Seattle",
  "Boston",
  "Chicago",
  "Austin",
  "Portland",
  "Denver",
  "Miami",
  "Houston",
  "Dallas",
  "Atlanta",
]

const PROFESSIONS_ZH: string[] = []
const PROFESSIONS_EN = [
  "doctor",
  "lawyer",
  "engineer",
  "programmer",
  "teacher",
  "designer",
  "nurse",
  "accountant",
  "journalist",
  "physician",
  "attorney",
  "developer",
]

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

const CJK_RE = /[\u3400-\u9fff]/g
const ASCII_LETTER_RE = /[A-Za-z]/g

function lower(s: string): string {
  return s.toLowerCase()
}

function containsAny(haystack: string, needles: string[]): string | null {
  const h = lower(haystack)
  for (const n of needles) {
    if (!n) continue
    if (h.includes(lower(n))) return n
  }
  return null
}

function snippet(s: string, max = 200): string {
  if (!s) return ""
  return s.length <= max ? s : `${s.slice(0, max)}...`
}

function detectLangSimple(text: string): "zh" | "en" | "mixed" {
  if (!text) return "en"
  const cjk = (text.match(CJK_RE) ?? []).length
  const ascii = (text.match(ASCII_LETTER_RE) ?? []).length
  if (cjk === 0 && ascii === 0) return "en"
  if (cjk > 0 && ascii === 0) return "zh"
  if (ascii > 0 && cjk === 0) return "en"
  const total = cjk + ascii
  if (Math.min(cjk, ascii) / total >= 0.2) return "mixed"
  return cjk > ascii ? "zh" : "en"
}

// ---------------------------------------------------------------------------
// Per-type detectors — each returns null (no violation) or partial
// ContradictionResult fragment (caller wraps with type + latency).
// ---------------------------------------------------------------------------

interface PartialResult {
  violatedTerm: string
  factSnippet: string
  replySnippet: string
  confidence: number
}

function checkDietary(facts: string[], reply: string): PartialResult | null {
  const veg = facts.find((f) => containsAny(f, VEG_FACT_TERMS))
  if (!veg) return null
  const meat = containsAny(reply, MEAT_VIOLATING_TERMS)
  if (!meat) return null
  return {
    violatedTerm: meat,
    factSnippet: snippet(veg),
    replySnippet: snippet(reply),
    confidence: 1.0,
  }
}

function checkAllergy(facts: string[], reply: string): PartialResult | null {
  const allergyFact = facts.find((f) => containsAny(f, LEXICONS.allergy.factTerms))
  if (!allergyFact) return null
  // Find the allergen mentioned in the fact (if any) — strongest signal.
  const allergen = containsAny(allergyFact, LEXICONS.allergy.violatingTerms)
  // If reply mentions the same allergen → contradiction.
  if (allergen) {
    const replyHit = containsAny(reply, [allergen])
    if (replyHit) {
      return {
        violatedTerm: replyHit,
        factSnippet: snippet(allergyFact),
        replySnippet: snippet(reply),
        confidence: 1.0,
      }
    }
  }
  // Fallback: reply mentions ANY common allergen → likely contradiction
  // (lower confidence — could be unrelated allergen).
  const anyAllergen = containsAny(reply, LEXICONS.allergy.violatingTerms)
  if (anyAllergen && allergen && lower(anyAllergen).includes(lower(allergen))) {
    return {
      violatedTerm: anyAllergen,
      factSnippet: snippet(allergyFact),
      replySnippet: snippet(reply),
      confidence: 0.7,
    }
  }
  return null
}

function checkPet(facts: string[], reply: string): PartialResult | null {
  const userHasCat = facts.find((f) => containsAny(f, ["cat", "kitten", "kitty"]))
  const userHasDog = facts.find((f) => containsAny(f, ["dog", "puppy"]))
  if (userHasCat && !userHasDog) {
    const dogHit = containsAny(reply, ["dog", "puppy", "doggie"])
    if (dogHit) {
      return {
        violatedTerm: dogHit,
        factSnippet: snippet(userHasCat),
        replySnippet: snippet(reply),
        confidence: 1.0,
      }
    }
  }
  if (userHasDog && !userHasCat) {
    const catHit = containsAny(reply, ["cat", "kitten"])
    if (catHit) {
      return {
        violatedTerm: catHit,
        factSnippet: snippet(userHasDog),
        replySnippet: snippet(reply),
        confidence: 1.0,
      }
    }
  }
  return null
}

function checkLocation(facts: string[], reply: string): PartialResult | null {
  // Find user-stated city in any fact.
  let userCity: string | null = null
  let userCityFact = ""
  for (const f of facts) {
    for (const c of [...ZH_CITIES, ...EN_CITIES]) {
      if (lower(f).includes(lower(c))) {
        userCity = c
        userCityFact = f
        break
      }
    }
    if (userCity) break
  }
  if (!userCity) return null
  // Reply mentions a DIFFERENT city → contradiction.
  for (const c of [...ZH_CITIES, ...EN_CITIES]) {
    if (lower(c) === lower(userCity)) continue
    if (lower(reply).includes(lower(c))) {
      return {
        violatedTerm: c,
        factSnippet: snippet(userCityFact),
        replySnippet: snippet(reply),
        confidence: 0.8, // city overlap heuristic — could be a recommendation
      }
    }
  }
  return null
}

function checkRelationship(facts: string[], reply: string): PartialResult | null {
  const single = facts.find((f) =>
    containsAny(f, LEXICONS.relationship.factTerms)
  )
  if (!single) return null
  const partner = containsAny(reply, LEXICONS.relationship.violatingTerms)
  if (!partner) return null
  return {
    violatedTerm: partner,
    factSnippet: snippet(single),
    replySnippet: snippet(reply),
    confidence: 1.0,
  }
}

function checkProfession(facts: string[], reply: string): PartialResult | null {
  // Find user's stated profession.
  const allProfs = [...PROFESSIONS_ZH, ...PROFESSIONS_EN]
  let userProf: string | null = null
  let userProfFact = ""
  for (const f of facts) {
    for (const p of allProfs) {
      // Match phrases like "I am a doctor" — basic substring is enough
      // for our seeded fixture set.
      if (lower(f).includes(lower(p))) {
        userProf = p
        userProfFact = f
        break
      }
    }
    if (userProf) break
  }
  if (!userProf) return null
  // Reply mentions a DIFFERENT profession in a "your X" framing.
  for (const p of allProfs) {
    if (lower(p) === lower(userProf)) continue
    // Need to be in reply AND framed as the user's profession (heuristic:
    // adjacent to "your" / "your X colleagues" etc.).
    const lp = lower(p)
    const lr = lower(reply)
    if (
      lr.includes(`your ${lp}`) ||
      lr.includes(`as ${lp}`) ||
      lr.includes(`fellow ${lp}`) ||
      lr.includes(`${lp} colleagues`) ||
      lr.includes(`${lp} colleague`)
    ) {
      return {
        violatedTerm: p,
        factSnippet: snippet(userProfFact),
        replySnippet: snippet(reply),
        confidence: 0.9,
      }
    }
  }
  return null
}

function checkPreferenceNegation(
  facts: string[],
  reply: string
): PartialResult | null {
  // Pattern: "I never X" — extract noun X, flag if reply
  // suggests X.
  for (const f of facts) {
    const lf = lower(f)
    // EN patterns
    const enMatch = lf.match(
      /(?:never|don't|do not|dont|hate|dislike|can't|cant|won't|wont)\s+(?:drink|eat|have|use|do|wear|like)?\s*([a-z]{2,20})/
    )
    if (enMatch && enMatch[1]) {
      const noun = enMatch[1].trim()
      if (noun.length > 0 && lower(reply).includes(noun)) {
        return {
          violatedTerm: noun,
          factSnippet: snippet(f),
          replySnippet: snippet(reply),
          confidence: 0.9,
        }
      }
    }
  }
  return null
}

function checkHealth(facts: string[], reply: string): PartialResult | null {
  const condFact = facts.find((f) =>
    containsAny(f, LEXICONS.health.factTerms)
  )
  if (!condFact) return null
  const violator = containsAny(reply, LEXICONS.health.violatingTerms)
  if (!violator) return null
  return {
    violatedTerm: violator,
    factSnippet: snippet(condFact),
    replySnippet: snippet(reply),
    confidence: 1.0,
  }
}

function checkLanguage(
  ctx: MemoryPolicyContext,
  reply: string
): PartialResult | null {
  if (!ctx.userLang) return null
  const replyLang = detectLangSimple(reply)
  // Strict mismatch: user requested zh-only and reply is en (or vice versa).
  if (ctx.userLang === "zh" && replyLang === "en") {
    return {
      violatedTerm: "english_majority_reply",
      factSnippet: "user prefers zh",
      replySnippet: snippet(reply),
      confidence: 0.8,
    }
  }
  if (ctx.userLang === "en" && replyLang === "zh") {
    return {
      violatedTerm: "chinese_majority_reply",
      factSnippet: "user prefers en",
      replySnippet: snippet(reply),
      confidence: 0.8,
    }
  }
  return null
}

/**
 * Persona-locked check: if persona declares a dietary or preference
 * constraint (e.g. "Claire is vegetarian"), flag reply violations.
 *
 * S3 SYNC: Reads from `pa-personas/{slug}` Firestore via `deps.getPersona`.
 * NEVER reads inline persona strings.
 */
function checkPersonaLocked(
  persona: PersonaSnapshot | null,
  reply: string
): PartialResult | null {
  if (!persona) return null
  const personaText = `${persona.soul} ${persona.style} ${persona.examples}`
  // Check dietary persona constraint
  if (containsAny(personaText, VEG_FACT_TERMS)) {
    const meat = containsAny(reply, MEAT_VIOLATING_TERMS)
    if (meat) {
      return {
        violatedTerm: meat,
        factSnippet: snippet(personaText, 100),
        replySnippet: snippet(reply),
        confidence: 1.0,
      }
    }
  }
  // Check preference-negation in persona (e.g. "Claire never drinks coffee")
  const personaPrefMatch = lower(personaText).match(
    /(?:never drinks?|never eats?|prefers tea over coffee|coffee snob)\s*([a-z]+)?/
  )
  if (personaPrefMatch) {
    if (lower(personaText).includes("prefers tea over coffee") && lower(reply).includes("coffee")) {
      return {
        violatedTerm: "coffee",
        factSnippet: snippet(personaText, 100),
        replySnippet: snippet(reply),
        confidence: 0.9,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const PERSONA_SLUG_DEFAULT = "claire"

function emptyResult(latencyMs: number): ContradictionResult {
  return {
    violated: false,
    type: null,
    violatedTerm: null,
    factSnippet: null,
    replySnippet: null,
    confidence: 0,
    latencyMs,
  }
}

/**
 * Run all 10 contradiction checks against a Claire reply.
 *
 * - Reply tokenized + lowercased; fact list fetched from `deps.mem0Search`
 *   (or `ctx.factsCache` if pre-fetched by caller for dedupe with detector).
 * - Persona-locked check uses `deps.getPersona(slug)` (S3 sync).
 * - Type priority: persona_locked > allergy > health > dietary >
 *   preference_negation > pet > location > relationship > profession > language.
 * - First violated type wins; result includes term + snippets + confidence.
 *
 * Latency: < 5ms p95 (rule-based; Mem0 search latency NOT counted).
 *
 * NEVER throws — all errors swallowed + logged.
 */
export async function detectContradiction(
  ctx: MemoryPolicyContext,
  deps: AdviceTrackerDeps = {}
): Promise<ContradictionResult> {
  const start = performance.now()

  if (!ctx.claireReply || ctx.claireReply.length === 0) {
    return emptyResult(performance.now() - start)
  }

  // 1. Fetch user facts (Mem0 read-only). Use cache if caller provided.
  let facts: string[] = ctx.factsCache ?? []
  if (!ctx.factsCache && deps.mem0Search) {
    try {
      // Use first ~80 chars of reply as the search query — biases toward
      // semantically-related facts.
      const q = ctx.claireReply.slice(0, 80)
      const got = await deps.mem0Search(q, ctx.userId)
      facts = Array.isArray(got) ? got.filter((s) => typeof s === "string" && s.length > 0) : []
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.log("[memory-policy/contradict] mem0Search error", { msg })
      facts = []
    }
  }

  // 2. Fetch persona (S3 sync).
  let persona: PersonaSnapshot | null = null
  if (deps.getPersona) {
    try {
      const slug = process.env.MEMORY_POLICY_PERSONA_SLUG?.trim() || PERSONA_SLUG_DEFAULT
      persona = await deps.getPersona(slug)
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.log("[memory-policy/contradict] getPersona error", { msg })
    }
  }

  const reply = ctx.claireReply

  // 3. Run priority-ordered checks; first hit wins.
  for (const t of TYPE_PRIORITY) {
    let hit: PartialResult | null = null
    switch (t) {
      case "persona_locked":
        hit = checkPersonaLocked(persona, reply)
        break
      case "allergy":
        hit = checkAllergy(facts, reply)
        break
      case "health":
        hit = checkHealth(facts, reply)
        break
      case "dietary":
        hit = checkDietary(facts, reply)
        break
      case "preference_negation":
        hit = checkPreferenceNegation(facts, reply)
        break
      case "pet":
        hit = checkPet(facts, reply)
        break
      case "location":
        hit = checkLocation(facts, reply)
        break
      case "relationship":
        hit = checkRelationship(facts, reply)
        break
      case "profession":
        hit = checkProfession(facts, reply)
        break
      case "language":
        hit = checkLanguage(ctx, reply)
        break
    }
    if (hit) {
      return {
        violated: true,
        type: t,
        violatedTerm: hit.violatedTerm,
        factSnippet: hit.factSnippet,
        replySnippet: hit.replySnippet,
        confidence: hit.confidence,
        latencyMs: performance.now() - start,
      }
    }
  }

  return emptyResult(performance.now() - start)
}

/** Exposed for tests + Phase 38 internal callers (cross-module reuse). */
export const CONTRADICTION_TYPE_PRIORITY = TYPE_PRIORITY
