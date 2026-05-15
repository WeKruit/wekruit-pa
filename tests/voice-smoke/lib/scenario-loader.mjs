/**
 * v2.1 S6 — Scenario loader for voice smoke tests.
 *
 * Loads YAML scenarios with env-var interpolation (`${VAR}`) for phone
 * numbers + caller IDs so the repo never carries raw PII. Pure module
 * (no I/O at import time, no side effects).
 */
import { readFile, readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"

/** Substitute `${VAR}` tokens in a string. Throws when --strict + missing. */
export function interpolate(value, env, opts = {}) {
  if (typeof value !== "string") return value
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, varName) => {
    const v = env[varName]
    if (v === undefined || v === "") {
      if (opts.strict) {
        throw new Error(`scenario interpolation: env var ${varName} missing`)
      }
      return ""
    }
    return v
  })
}

/** Walk a parsed scenario tree and interpolate every string leaf. */
export function interpolateTree(node, env, opts = {}) {
  if (node === null || node === undefined) return node
  if (typeof node === "string") return interpolate(node, env, opts)
  if (Array.isArray(node)) return node.map((n) => interpolateTree(n, env, opts))
  if (typeof node === "object") {
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = interpolateTree(v, env, opts)
    }
    return out
  }
  return node
}

/** Validate the shape produced after interpolation. Returns the scenario or throws. */
export function validateScenario(scenario, sourcePath) {
  const err = (msg) => new Error(`${sourcePath}: ${msg}`)
  if (!scenario || typeof scenario !== "object") throw err("scenario must be an object")
  if (typeof scenario.id !== "string" || scenario.id.length === 0) throw err("missing id")
  if (typeof scenario.description !== "string") throw err("missing description")
  if (!scenario.voice || typeof scenario.voice !== "object") throw err("missing voice block")
  const v = scenario.voice
  if (typeof v.expectedOutcome !== "string") throw err("missing voice.expectedOutcome")
  if (!["PASS", "NOT_PASS", "PAUSE", "HANGUP"].includes(v.expectedOutcome)) {
    throw err(`voice.expectedOutcome must be PASS|NOT_PASS|PAUSE|HANGUP (got ${v.expectedOutcome})`)
  }
  if (!scenario.context || typeof scenario.context !== "object") throw err("missing context block")
  if (typeof scenario.context.paUserId !== "string") throw err("missing context.paUserId")
  if (typeof scenario.context.paJobId !== "string") throw err("missing context.paJobId")
  if (!scenario.thresholds || typeof scenario.thresholds !== "object") {
    throw err("missing thresholds block")
  }
  return scenario
}

/** Load a single scenario file. */
export async function loadScenarioFile(path, env = process.env, opts = {}) {
  const text = await readFile(path, "utf8")
  const parsed = parseYaml(text)
  const interp = interpolateTree(parsed, env, opts)
  return validateScenario(interp, path)
}

/** Load all `*.yaml` scenarios in a directory, sorted by filename. */
export async function loadScenariosDir(dir, env = process.env, opts = {}) {
  const s = await stat(dir)
  if (!s.isDirectory()) throw new Error(`not a directory: ${dir}`)
  const entries = await readdir(dir)
  const yamlFiles = entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => resolve(dir, f))
  const out = []
  for (const f of yamlFiles) {
    out.push(await loadScenarioFile(f, env, opts))
  }
  return out
}

/** Parse a CLI flag from argv (returns value or null). */
export function parseFlag(argv, name) {
  const idx = argv.indexOf(`--${name}`)
  if (idx < 0) return null
  const next = argv[idx + 1]
  if (!next || next.startsWith("--")) return null
  return next
}

export function parseBoolFlag(argv, name) {
  return argv.includes(`--${name}`)
}
