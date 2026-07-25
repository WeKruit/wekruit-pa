/**
 * Resolve every school / company / major / location string in a cohort to a CANONICAL TOKEN, and
 * emit the alias overlay the matcher reads (`src/yc-entity-overlay.generated.ts`).
 *
 * WHY THIS EXISTS: the facet stage used to compare raw strings by substring, which is why a bare
 * "rl" matched "world" and "early". Tokens fix that only if both sides canonicalize the same way,
 * so the resolution has to happen ONCE, offline, into a table both sides read.
 *
 * WHAT NEEDS THE LLM, measured on the live 992-record cohort (2026-07-25):
 *   school    1086/1087 distinct (99.9%) resolve deterministically off the 763-school alias
 *             dataset already in `@wekruit/shared-tags` — no LLM.
 *   company   4145/4148 (99.9%) resolve by legal-suffix stripping — no LLM.
 *   major        14/1346 (1.0%)  — degree prose ("Bachelor of Science - BS, Computer Science").
 *   location      2/301  (0.7%)  — postal prose ("Cambridge, Massachusetts, United States").
 * So nano runs over majors and locations ONLY: ~1600 values, ~40 calls. Classifying prose into a
 * closed vocabulary is exactly the semantic judgment Adam asked for, and exactly what no amount
 * of pattern matching was ever going to get right.
 *
 * WHY A GENERATED .ts AND NOT FIRESTORE: `school-strength-priors.ts` is the repo's own precedent —
 * a generated data module. It keeps the overlay off the hot path (no read per cold start), in git
 * (reviewable diff), and hermetic in tests.
 *
 * IDEMPOTENT: re-reads the existing overlay and only asks about values it does not already hold,
 * so a re-run after new attendees import costs a handful of calls, not 40.
 *
 * Run:
 *   export GOOGLE_APPLICATION_CREDENTIALS=... ; export PA_OPENAI_AGENT_API_KEY=...
 *   node --import tsx apps/functions/scripts/canonicalize-yc-entities.ts <cohort> [--apply] [--limit N]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { LOCATION_VOCAB, MAJOR_VOCAB } from "@wekruit/shared-tags"
import { callWithFallback } from "@pa/pa-resume-parser"
import {
  canonicalEntityToken,
  entityFoldKey,
  entityParenAlias,
  type EntityKind,
  type EntityOverlay,
} from "../src/entity-token.js"
import { YC_COHORT_2026 } from "../src/yc-people-match.js"

const require = createRequire(`${process.cwd()}/apps/functions/`)
const admin = require("firebase-admin")

const RECORDS = "pa-external-candidate-records"
const OUT_FILE = "apps/functions/src/yc-entity-overlay.generated.ts"
const BATCH = 40
/**
 * Fold a company into its parent only once at least this many attendees list it. 4148 distinct
 * employers, but 838 appear twice or more — and a singleton employer moves at most one person
 * while being the hardest for the model to be right about. Lower this if a real ask misses.
 */
const MIN_PARENT_COUNT = 2
const CONCURRENCY = 6

/** Only these two need judgment; school/company resolve deterministically. See the header. */
const LLM_KINDS = ["major", "location"] as const

const VOCAB: Record<(typeof LLM_KINDS)[number], readonly string[]> = {
  major: MAJOR_VOCAB,
  location: LOCATION_VOCAB,
}

const PROMPT: Record<(typeof LLM_KINDS)[number], string> = {
  major: `You map a degree/education string to ONE canonical field-of-study token.

Return the token from the allowed list that names the FIELD STUDIED. Ignore the degree level —
"Bachelor of Science - BS, Computer Science", "MS Computer Science" and "Computer Science" are all
computer_science.

Return "" (empty) when the string names no field of study: a bare degree level ("Bachelor's degree",
"BS"), a school stage ("High School Diploma", "Dual Enrollment"), a programme name ("Startup School"),
or a field with no reasonable home in the list. "" is a correct and common answer — never stretch to
the nearest token. A wrong token silently puts a person in someone else's search results.`,
  location: `You map a place string to ONE canonical metro token.

Pick the metro the place belongs to: "Cambridge, Massachusetts, United States" is boston_metro,
"Stanford, California, United States" and "Palo Alto, CA" are san_francisco_bay_area, "Brooklyn, NY"
is new_york_metro.

Return "" (empty) when the string is not resolvable to ONE metro in the list: a bare country
("United States", "India"), a whole state or province ("California", "Ontario"), a region, or a city
with no metro in the list. "" is a correct and common answer — never stretch to the nearest token.
A wrong token silently puts a person in someone else's search results.`,
}

/**
 * PARENT RESOLUTION — the second nano pass, over schools and companies.
 *
 * MEASURED NEED, not a guess (2026-07-25, live 988-person pool): plain identity tokens lost 17
 * Berkeley people and 11 Stanford people, because "UC Berkeley College of Engineering", "…Haas
 * School of Business" and "UC Berkeley EECS" are all distinct strings and all obviously Berkeley.
 * Substring matching got those right by accident, and got "Metaculus" ⊂ "Meta" wrong by the same
 * accident. Folding a constituent school into its university is the semantic judgment that keeps
 * the first and not the second.
 *
 * The model returns a PARENT NAME, which is then canonicalized through the same deterministic
 * resolver — so the parent has to be a real entity we already know, and a hallucinated parent
 * resolves to its own harmless token rather than silently merging two institutions.
 */
const PARENT_KINDS = ["school", "company"] as const

const PARENT_PROMPT: Record<(typeof PARENT_KINDS)[number], string> = {
  school: `You are given the name of a school or education organization. Return the DEGREE-GRANTING
PARENT UNIVERSITY it is a constituent part of.

Return the parent ONLY for a constituent college, school, department, institute or degree programme
of a university:
  "UC Berkeley College of Engineering" -> "University of California, Berkeley"
  "University of California, Berkeley, Haas School of Business" -> "University of California, Berkeley"
  "The Wharton School" -> "University of Pennsylvania"
  "Jerome Fisher M&T Program" -> "University of Pennsylvania"
  "Stanford University School of Medicine" -> "Stanford University"

Return "" (empty) for everything else, including:
  - an institution that already IS the top-level university ("Stanford University", "MIT")
  - a standalone school ("Menlo School", "Enloe High School", "Phillips Academy")
  - a SEPARATELY-ADMITTED programme that merely carries a university's name — a high school, an
    online academy, a summer session, an extension or continuing-education arm, a pre-college
    programme, a math circle. "Stanford Online High School", "Stanford Summer Session" and
    "Berkeley Math Circle" are all "" — attending one does not make somebody an alum.
  - anything that is not a school.
"" is a correct and very common answer. A wrong parent silently puts a person in another
university's alumni results.`,
  company: `You are given an employer name. Return the PARENT COMPANY it is a division, subsidiary or
renamed part of — the name a person would search for instead.

  "Google DeepMind" -> "Google"
  "Amazon Web Services" -> "Amazon"
  "Instagram" -> "Meta"

Return "" (empty) for everything else, including:
  - an independent company, however small ("Metaculus", "MetaProp", "Stripe")
  - a company that merely shares a word with a bigger one
  - a volunteer or community programme, student club, hackathon, conference, fellowship or
    open-source project rather than an employer ("Google Developer Student Club",
    "Google Summer of Code", "Major League Hacking")
  - a company whose parent you are not confident about.
"" is a correct and very common answer. A wrong parent silently puts a person in another company's
alumni results.`,
}

async function resolveParents(
  kind: (typeof PARENT_KINDS)[number],
  values: string[],
  apiKey: string,
  overlay: EntityOverlay,
): Promise<Array<[string, string]>> {
  const res = await callWithFallback({
    apiKey,
    systemPrompt: `${PARENT_PROMPT[kind]}\n\nReturn one mapping per input line, echoing the input verbatim as "raw" and the parent name (or "") as "token".`,
    userText: values.map((v, i) => `${i + 1}. ${v}`).join("\n"),
    schemaName: `${kind}_parent_entity`,
    schema: SCHEMA as unknown as Record<string, unknown>,
  })
  const parsed = JSON.parse(res.rawJson) as { mappings?: Array<{ raw?: unknown; token?: unknown }> }
  const asked = new Map(values.map((v) => [entityFoldKey(v), v]))
  const out: Array<[string, string]> = []
  for (const m of parsed.mappings ?? []) {
    const echoed = typeof m?.raw === "string" ? m.raw : ""
    const parentName = typeof m?.token === "string" ? m.token.trim() : ""
    const key = entityFoldKey(echoed.replace(/^\s*\d+[.)]\s*/, ""))
    const original = asked.get(key)
    if (!key || !original || !parentName) continue
    // The parent goes through the SAME deterministic resolver, so an invented parent lands on its
    // own token instead of merging two real institutions.
    const parentToken = canonicalEntityToken(kind, parentName, overlay)
    const ownToken = canonicalEntityToken(kind, original, overlay)
    if (!parentToken || parentToken === ownToken) continue
    out.push([key, parentToken])
  }
  return out
}

/**
 * Resolve overlay chains to a fixed point.
 *
 * Needed because the passes compose: the parenthetical pass records aws → amazon_web_services and
 * the parent pass records amazon web services → amazon, so a query for "AWS" and a member row
 * reading "Amazon Web Services (AWS)" would land on DIFFERENT tokens and fail to match. Following
 * each value through the table until it stops moving makes the overlay self-consistent.
 */
function collapseChains(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, token] of Object.entries(map)) {
    let cur = token
    const seen = new Set([key, cur])
    for (let hop = 0; hop < 5; hop++) {
      const next = map[cur.replace(/_/g, " ")]
      if (!next || seen.has(next)) break
      seen.add(next)
      cur = next
    }
    out[key] = cur
  }
  return out
}

const SCHEMA = {
  type: "object",
  properties: {
    mappings: {
      type: "array",
      items: {
        type: "object",
        properties: { raw: { type: "string" }, token: { type: "string" } },
        // strict json_schema requires `required` ⊇ `properties` — a partial list 400s.
        required: ["raw", "token"],
        additionalProperties: false,
      },
    },
  },
  required: ["mappings"],
  additionalProperties: false,
} as const

async function classify(
  kind: (typeof LLM_KINDS)[number],
  values: string[],
  apiKey: string,
): Promise<Array<[string, string]>> {
  const allowed = VOCAB[kind]
  const res = await callWithFallback({
    apiKey,
    systemPrompt: `${PROMPT[kind]}\n\nAllowed tokens:\n${allowed.join(", ")}\n\nReturn one mapping per input line, echoing the input verbatim as "raw".`,
    userText: values.map((v, i) => `${i + 1}. ${v}`).join("\n"),
    schemaName: `${kind}_canonical_tokens`,
    schema: SCHEMA as unknown as Record<string, unknown>,
  })
  const parsed = JSON.parse(res.rawJson) as { mappings?: Array<{ raw?: unknown; token?: unknown }> }
  const allow = new Set(allowed)
  // Only keys we actually asked about may enter the overlay. Measured 2026-07-25: the model
  // echoes the "1. " line numbering back inside `raw`, which silently produced 1018 unreachable
  // keys ("1 bachelor of science bs computer science") until this check caught them.
  const asked = new Set(values.map((v) => entityFoldKey(v)))
  const out: Array<[string, string]> = []
  for (const m of parsed.mappings ?? []) {
    const echoed = typeof m?.raw === "string" ? m.raw : ""
    const token = typeof m?.token === "string" ? m.token.trim() : ""
    const key = entityFoldKey(echoed.replace(/^\s*\d+[.)]\s*/, ""))
    // Drop anything outside the closed vocab rather than trusting the model to stay in it.
    if (!key || !asked.has(key) || !token || !allow.has(token)) continue
    out.push([key, token])
  }
  return out
}

/** Read the overlay we already generated, so a re-run only asks about what is new. */
function readExistingOverlay(): EntityOverlay {
  try {
    const src = readFileSync(OUT_FILE, "utf8")
    const start = src.indexOf("{", src.indexOf("YC_ENTITY_OVERLAY"))
    const end = src.lastIndexOf("}")
    if (start < 0 || end < start) return {}
    return JSON.parse(src.slice(start, end + 1).replace(/,(\s*[}\]])/g, "$1")) as EntityOverlay
  } catch {
    return {}
  }
}

function emit(overlay: EntityOverlay): string {
  const kinds: EntityKind[] = ["school", "company", "major", "location"]
  const body = kinds
    .map((k) => {
      const entries = Object.entries(overlay[k] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))
      const rows = entries.map(([raw, token]) => `    ${JSON.stringify(raw)}: ${JSON.stringify(token)},`)
      // Keys are QUOTED so the emitted object is valid JSON as well as valid TS — `readExistingOverlay`
      // parses this file back to decide what it may skip, and unquoted keys silently defeated that.
      return `  ${JSON.stringify(k)}: {\n${rows.join("\n")}\n  },`
    })
    .join("\n")
  return `/**
 * GENERATED by scripts/canonicalize-yc-entities.ts — do not edit by hand.
 *
 * normalizedRawValue → canonical token, for the values the deterministic canonicalizer in
 * \`entity-token.ts\` cannot resolve on its own (degree prose, postal prose) plus the free
 * parenthetical aliases ("Amazon Web Services (AWS)" ⇒ aws). Both the index side and the query
 * side read this, which is the only reason a facet can match at all — see \`canonicalEntityToken\`.
 *
 * Generated ${new Date().toISOString()}.
 */
import type { EntityOverlay } from "./entity-token.js"

export const YC_ENTITY_OVERLAY: EntityOverlay = {
${body}
}
`
}

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

async function main() {
  const cohort = process.argv[2] ?? YC_COHORT_2026
  const apply = process.argv.includes("--apply")
  const limitIdx = process.argv.indexOf("--limit")
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity
  const apiKey = process.env.PA_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error("OPENAI key missing")
    process.exit(2)
  }

  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, "utf8")),
    ),
  })
  const db = admin.firestore()

  const snap = await db.collection(RECORDS).where("enrichment.cohort", "==", cohort).get()
  // raw value → kind, plus the free parenthetical aliases.
  const distinct: Record<EntityKind, Map<string, number>> = {
    school: new Map(), company: new Map(), major: new Map(), location: new Map(),
  }
  const overlay = readExistingOverlay()
  // alias → every token that claims it. An alias claimed by two different entities is AMBIGUOUS
  // and is dropped: "(AI)" would otherwise bind whichever company happened to be seen first.
  const parenClaims: Record<EntityKind, Map<string, Set<string>>> = {
    school: new Map(), company: new Map(), major: new Map(), location: new Map(),
  }
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>
    if (d.coresignalMatch !== "ok") continue
    const edu = (Array.isArray(d.education) ? d.education : []) as Array<Record<string, unknown>>
    const exp = (Array.isArray(d.experience) ? d.experience : []) as Array<Record<string, unknown>>
    const add = (kind: EntityKind, raw: string) => {
      if (!raw) return
      distinct[kind].set(raw, (distinct[kind].get(raw) ?? 0) + 1)
      // "Amazon Web Services (AWS)" registers aws → amazon_web_services. Deterministic, no LLM.
      const alias = entityParenAlias(raw)
      const token = canonicalEntityToken(kind, raw, overlay)
      if (!alias || !token || alias === token) return
      if (!parenClaims[kind].has(alias)) parenClaims[kind].set(alias, new Set())
      parenClaims[kind].get(alias)!.add(token)
    }
    for (const e of edu) { add("school", s(e.school)); add("major", s(e.degree)) }
    for (const e of exp) add("company", s(e.company))
    add("location", s(d.location))
  }

  type Batch = { pass: "vocab" | "parent"; kind: EntityKind; values: string[] }
  const todo: Batch[] = []
  const push = (pass: Batch["pass"], kind: EntityKind, need: string[]) => {
    for (let i = 0; i < need.length; i += BATCH) todo.push({ pass, kind, values: need.slice(i, i + BATCH) })
  }
  for (const kind of LLM_KINDS) {
    const have = overlay[kind] ?? {}
    const need = [...distinct[kind].keys()].filter((raw) => {
      const key = entityFoldKey(raw)
      // Already answered, or the deterministic layer already resolves it — either way, no call.
      return key && !(key in have) && !canonicalEntityToken(kind, raw, overlay)
    })
    push("vocab", kind, need)
  }
  for (const kind of PARENT_KINDS) {
    const have = overlay[kind] ?? {}
    const need = [...distinct[kind].entries()]
      .filter(([raw, count]) => {
        const key = entityFoldKey(raw)
        if (!key || key in have) return false
        if (kind === "school") {
          // Only the tail: a value the 763-school alias dataset did NOT recognise fell through to
          // its own slug, and that is exactly where "UC Berkeley College of Engineering" lives.
          return canonicalEntityToken(kind, raw, overlay) === key.replace(/ /g, "_")
        }
        // Companies have no alias dataset, so gate on how many people it would actually move.
        // A singleton employer is the riskiest thing to fold and moves at most one person.
        return count >= MIN_PARENT_COUNT
      })
      .map(([raw]) => raw)
    push("parent", kind, need)
  }
  const work = todo.slice(0, limit === Infinity ? todo.length : limit)
  console.log(
    `[yc-canon] cohort=${cohort} records=${snap.size} ` +
      (["school", "company", "major", "location"] as EntityKind[])
        .map((k) => `${k}=${distinct[k].size}`)
        .join(" ") +
      ` batches=${todo.length} (vocab=${todo.filter((t) => t.pass === "vocab").length}` +
      ` parent=${todo.filter((t) => t.pass === "parent").length}) doing=${work.length}`,
  )
  if (!apply) {
    console.log("[yc-canon] DRY RUN — pass --apply")
    console.log(work[0]?.values.slice(0, 10))
    return
  }

  const resolved: Record<EntityKind, Record<string, string>> = {
    school: {}, company: {}, major: {}, location: {},
  }
  let done = 0
  let failed = 0
  let cursor = 0
  const worker = async () => {
    while (cursor < work.length) {
      const batch = work[cursor++]!
      try {
        const pairs =
          batch.pass === "vocab"
            ? await classify(batch.kind as (typeof LLM_KINDS)[number], batch.values, apiKey)
            : await resolveParents(batch.kind as (typeof PARENT_KINDS)[number], batch.values, apiKey, overlay)
        for (const [key, token] of pairs) resolved[batch.kind][key] = token
        done++
      } catch (err) {
        failed++
        console.error(`[yc-canon] fail ${batch.pass}/${batch.kind}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if ((done + failed) % 5 === 0) console.log(`[yc-canon] ${done + failed}/${work.length} (failed=${failed})`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  /** Unambiguous parenthetical aliases only — an alias two entities claim names neither. */
  const paren = (kind: EntityKind): Record<string, string> => {
    const out: Record<string, string> = {}
    let dropped = 0
    for (const [alias, tokens] of parenClaims[kind]) {
      if (tokens.size === 1) out[alias] = [...tokens][0]!
      else dropped++
    }
    if (dropped) console.log(`[yc-canon] ${kind}: dropped ${dropped} ambiguous parenthetical alias(es)`)
    return out
  }
  const kinds: EntityKind[] = ["school", "company", "major", "location"]
  const merged: EntityOverlay = Object.fromEntries(
    kinds.map((k) => [
      k,
      collapseChains({ ...paren(k), ...(overlay[k] ?? {}), ...resolved[k] }),
    ]),
  )
  writeFileSync(OUT_FILE, emit(merged))
  const n = (k: EntityKind) => Object.keys(merged[k] ?? {}).length
  console.log(
    `[yc-canon] DONE batches ok=${done} failed=${failed} → ${OUT_FILE} ` +
      `school=${n("school")} company=${n("company")} major=${n("major")} location=${n("location")}`,
  )
}

void main().then(() => process.exit(0))
