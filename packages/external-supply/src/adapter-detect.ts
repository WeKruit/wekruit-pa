/**
 * External supply adapter detection.
 *
 * Pure heuristic: given a raw buffer + filename/mime + the set of registered
 * adapter signatures, return a deterministic ranked list of `(source,
 * confidence)` pairs. Higher confidence = stronger signal that this adapter
 * matches the input.
 *
 * Confidence formula (per L-B4):
 *   score = (requiredMatched / requiredCount)
 *         + min(0.15, bonusMatched * 0.05)
 *         - shapePenalty   // 0.3 if signature shape doesn't accept input shape
 *         + extHint        // +0.05 if filename extension matches a CSV/JSON
 *                          //   adapter on a CSV/JSON shape input
 * Clamped to [0, 1].
 *
 * Special cases:
 *  - `manual_csv` has `requiredKeys=[]`. Without a floor it would score 0 on
 *    JSON inputs and ~bonus on CSV inputs. We give it a fixed floor of 0.5
 *    (CSV shape) / 0.55 (`.csv` extension + CSV shape) so it remains the
 *    sub-0.6 fallback when no specific adapter clears the lock threshold.
 *  - `xlsx` files emit `shapeHint: "xlsx"` and yield no tokens (L-B1). Every
 *    specific adapter falls below 0.6, and `manual_csv` only scores its
 *    static floor — operator must supply column mapping. V3 will add real
 *    xlsx parsing.
 *  - Empty buffers + unparseable JSON/CSV degrade gracefully: no tokens
 *    extracted, all signatures score < 0.6, `manual_csv` wins by its floor.
 *
 * Determinism: sort by `(confidence desc, source asc)`. Same input always
 * produces the same output array.
 */

export type AdapterShape = "json" | "csv" | "tsv" | "xlsx" | "unknown"

/**
 * Adapter "fingerprint" used by detection. Each adapter file in
 * `apps/functions/src/external-supply/adapters/*.ts` exports its own
 * signature constant which the registry collects.
 */
export interface AdapterSignature {
  /** Stable adapter identifier (matches `ExternalSource` enum literal). */
  source: string
  /**
   * Keys whose presence in the input strongly indicates this adapter. For
   * JSON adapters these are dotted paths walked one level deep
   * (`profile.url`, `contact.primary_email`). For CSV adapters these are
   * header names compared case-insensitively after trimming.
   *
   * Empty array means the adapter is a fallback (matches anything).
   */
  requiredKeys: string[]
  /** Extra keys that boost confidence but aren't required. */
  bonusKeys: string[]
  /** Which input shapes this adapter can read. */
  acceptedShapes: AdapterShape[]
  /** Adapter version string (re-exported from the adapter module). */
  adapterVersion: string
}

export interface AdapterDetectionCandidate {
  source: string
  confidence: number
  requiredMatched: number
  requiredCount: number
  bonusMatched: number
  reasons: string[]
}

export interface AdapterDetection {
  /** Top-ranked adapter (always present; defaults to `manual_csv` floor). */
  top: AdapterDetectionCandidate
  /** Full ranked list, `top` included as index 0. Deterministic order. */
  candidates: AdapterDetectionCandidate[]
  /** Detected input shape. */
  shapeHint: AdapterShape
  /** Optional warnings: `"xlsx_not_yet_supported"`, etc. */
  warnings: string[]
}

export interface DetectAdapterInput {
  rawBytes: Buffer
  filename?: string
  mime?: string
  registry: AdapterSignature[]
}

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]) // "PK\x03\x04"

function looksLikeXlsx(rawBytes: Buffer, filename?: string, mime?: string): boolean {
  if (filename && /\.xlsx$/i.test(filename)) return true
  if (mime && /spreadsheet|excel/i.test(mime)) return true
  // PK zip header — true for xlsx (also docx, but we're not expecting docx here)
  if (rawBytes.length >= 4 && rawBytes.subarray(0, 4).equals(XLSX_MAGIC)) {
    return true
  }
  return false
}

function detectShape(
  rawBytes: Buffer,
  filename?: string,
  mime?: string,
): AdapterShape {
  if (looksLikeXlsx(rawBytes, filename, mime)) return "xlsx"
  if (rawBytes.length === 0) return "unknown"

  // Sniff the first non-whitespace byte.
  const sample = rawBytes.subarray(0, Math.min(rawBytes.length, 4096)).toString("utf8")
  const trimmed = sample.replace(/^﻿/, "").trimStart()
  if (trimmed.length === 0) return "unknown"

  const first = trimmed.charAt(0)
  if (first === "[" || first === "{") return "json"

  // CSV / TSV — disambiguate by the first delimiter on the first line.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? ""
  if (firstLine.includes("\t") && !firstLine.includes(",")) return "tsv"
  if (firstLine.includes(",")) return "csv"
  // Single-column CSV (no delimiter) — treat as csv.
  return "csv"
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extract a deduplicated set of canonical tokens from the raw input. Tokens
 * are lowercased and trimmed so signature matching is case-insensitive.
 *
 *  - JSON: top-level keys of the first row; for object-valued top-level keys,
 *    also one level of `parent.child` dotted paths (L-B2). Handles either an
 *    array of objects or a single object; on parse failure returns [].
 *  - CSV/TSV: trimmed header names from line 1.
 *  - xlsx / unknown / empty: returns [].
 */
function extractTokens(rawBytes: Buffer, shape: AdapterShape): Set<string> {
  const out = new Set<string>()
  if (shape === "xlsx" || shape === "unknown" || rawBytes.length === 0) {
    return out
  }
  const text = rawBytes.toString("utf8").replace(/^﻿/, "")

  if (shape === "json") {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return out
    }
    const sample: unknown = Array.isArray(parsed) ? parsed[0] : parsed
    if (!sample || typeof sample !== "object") return out
    for (const [k, v] of Object.entries(sample as Record<string, unknown>)) {
      out.add(k.toLowerCase())
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const childKey of Object.keys(v as Record<string, unknown>)) {
          out.add(`${k.toLowerCase()}.${childKey.toLowerCase()}`)
        }
      }
    }
    return out
  }

  // CSV/TSV — header row only.
  const headerLine = text.split(/\r?\n/, 1)[0] ?? ""
  const delim = shape === "tsv" ? "\t" : ","
  for (const rawCell of headerLine.split(delim)) {
    // Strip wrapping double quotes + whitespace.
    const cell = rawCell.trim().replace(/^"(.*)"$/, "$1").trim()
    if (cell.length > 0) out.add(cell.toLowerCase())
  }
  return out
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function shapeAccepted(sig: AdapterSignature, shape: AdapterShape): boolean {
  if (shape === "unknown" || shape === "xlsx") return false
  return sig.acceptedShapes.includes(shape)
}

function extensionFromFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined
  const m = /\.([a-z0-9]+)$/i.exec(filename)
  return m ? m[1]!.toLowerCase() : undefined
}

function scoreSignature(
  sig: AdapterSignature,
  tokens: Set<string>,
  shape: AdapterShape,
  ext: string | undefined,
): AdapterDetectionCandidate {
  const reasons: string[] = []

  const requiredCount = sig.requiredKeys.length
  let requiredMatched = 0
  for (const k of sig.requiredKeys) {
    if (tokens.has(k.toLowerCase())) requiredMatched += 1
  }
  let bonusMatched = 0
  for (const k of sig.bonusKeys) {
    if (tokens.has(k.toLowerCase())) bonusMatched += 1
  }

  // Fallback adapter — pin to a floor below the 0.6 lock threshold so it
  // wins when no specific adapter clears the lock. Do NOT apply normal
  // formula (no required keys to satisfy).
  if (requiredCount === 0) {
    let floor: number
    if (shape === "csv" || shape === "tsv") {
      floor = ext === "csv" || ext === "tsv" ? 0.55 : 0.5
    } else {
      // xlsx / unknown / json — still beats specific adapters that scored 0
      // after their shape penalty, ensures fallback wins on empty / xlsx /
      // unparseable inputs (L-B1 / L-B4).
      floor = 0.5
    }
    reasons.push(`fallback_floor:${floor}`)
    return {
      source: sig.source,
      confidence: floor,
      requiredMatched: 0,
      requiredCount: 0,
      bonusMatched,
      reasons,
    }
  }

  const requiredRatio = requiredMatched / requiredCount
  reasons.push(`required_matched:${requiredMatched}/${requiredCount}`)

  const bonusBoost = Math.min(0.15, bonusMatched * 0.05)
  if (bonusMatched > 0) reasons.push(`bonus_matched:${bonusMatched}`)

  const shapeOk = shapeAccepted(sig, shape)
  const shapePenalty = shapeOk ? 0 : 0.3
  if (!shapeOk) reasons.push(`shape_penalty:${shape}_not_in_${sig.acceptedShapes.join("|")}`)

  // Extension hint: small +0.05 if filename extension matches one of the
  // signature's accepted shapes (and we don't already have a shape match
  // implied by penalty=0).
  let extHint = 0
  if (ext && (ext === "csv" || ext === "tsv" || ext === "json")) {
    if (sig.acceptedShapes.includes(ext as AdapterShape) && shapeOk) {
      extHint = 0.05
      reasons.push(`extension_hint:${ext}`)
    }
  }

  const raw = requiredRatio + bonusBoost - shapePenalty + extHint
  const confidence = Math.max(0, Math.min(1, raw))

  return {
    source: sig.source,
    confidence,
    requiredMatched,
    requiredCount,
    bonusMatched,
    reasons,
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Detect which adapter best matches the input. Pure: no I/O, no async, no
 * randomness. Same input → same output.
 */
export function detectAdapter(input: DetectAdapterInput): AdapterDetection {
  const { rawBytes, filename, mime, registry } = input
  const warnings: string[] = []

  const shape = detectShape(rawBytes, filename, mime)
  if (shape === "xlsx") {
    warnings.push("xlsx_not_yet_supported")
  }

  const tokens = extractTokens(rawBytes, shape)
  const ext = extensionFromFilename(filename)

  const candidates = registry
    .map((sig) => scoreSignature(sig, tokens, shape, ext))
    // Sort: higher confidence first, then source alpha for determinism.
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return a.source.localeCompare(b.source)
    })

  // We assume registry is non-empty + always includes a fallback signature
  // (`manual_csv`). If for some reason it doesn't, synthesize a neutral top.
  const top: AdapterDetectionCandidate = candidates[0] ?? {
    source: "manual_csv",
    confidence: 0,
    requiredMatched: 0,
    requiredCount: 0,
    bonusMatched: 0,
    reasons: ["empty_registry"],
  }

  return { top, candidates, shapeHint: shape, warnings }
}
