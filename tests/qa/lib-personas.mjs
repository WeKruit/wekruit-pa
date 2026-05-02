/**
 * Phase 50 — shared persona loader for the v1.5 QA team.
 *
 * One small responsibility: load + validate the 8 fixture JSONs in
 * tests/qa-personas/. All four QA agents share this module so a schema
 * mismatch surfaces in one place.
 */
import { readFileSync, readdirSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PERSONAS_DIR = resolve(__dirname, "..", "qa-personas")

const REQUIRED_FIELDS = [
  "id",
  "name",
  "language",
  "cv",
  "statedPreferences",
  "expected_assertions",
]

function validatePersona(p, file) {
  for (const k of REQUIRED_FIELDS) {
    if (!(k in p)) throw new Error(`persona ${file}: missing required field "${k}"`)
  }
  if (!["zh", "en"].includes(p.language)) {
    throw new Error(`persona ${file}: language must be "zh" or "en"`)
  }
  if (!Array.isArray(p.cv.skills) || p.cv.skills.length === 0) {
    throw new Error(`persona ${file}: cv.skills must be non-empty array`)
  }
  return p
}

export function loadAllPersonas() {
  const out = []
  const files = readdirSync(PERSONAS_DIR).filter((f) => f.endsWith(".json")).sort()
  for (const f of files) {
    const raw = readFileSync(join(PERSONAS_DIR, f), "utf8")
    const p = JSON.parse(raw)
    validatePersona(p, f)
    out.push({ ...p, _file: f })
  }
  return out
}

export function loadPersonaById(id) {
  return loadAllPersonas().find((p) => p.id === id) ?? null
}

export function pickPersonasByLanguage(personas, lang) {
  return personas.filter((p) => p.language === lang)
}

/**
 * Industry enum from apps/job-rec/src/types.ts JobIndustrySchema.
 * Kept in sync manually — Phase 50 D3 asserts persona industryTags ⊆ this set.
 */
export const JOB_INDUSTRY_ENUM = ["tech", "fintech", "healthtech", "consumer", "b2b", "any"]
