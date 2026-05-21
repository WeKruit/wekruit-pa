/**
 * Pure helpers extracted from CoresignalBatchNew.tsx so they're testable
 * without booting React + Firebase init (the .tsx file transitively imports
 * lib/firebase.ts which needs Vite env vars).
 */

export interface ParsedIds {
  ids: number[]
  invalidLines: string[]
}

export function parseIdList(input: string): ParsedIds {
  const text = input.trim()
  if (text.length === 0) return { ids: [], invalidLines: [] }

  // Try JSON array first
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) {
        const ids: number[] = []
        const invalidLines: string[] = []
        for (const item of parsed) {
          const n =
            typeof item === "number"
              ? item
              : typeof item === "string"
                ? Number.parseInt(item, 10)
                : NaN
          if (Number.isInteger(n) && n > 0) {
            ids.push(n)
          } else {
            invalidLines.push(String(item))
          }
        }
        return { ids, invalidLines }
      }
    } catch {
      // Fall through to line-by-line parse
    }
  }

  // Line-by-line (also handles comma + whitespace separators)
  const ids: number[] = []
  const invalidLines: string[] = []
  const tokens = text.split(/[\s,]+/).filter(Boolean)
  for (const token of tokens) {
    const clean = token.replace(/[^\d]/g, "")
    if (clean.length === 0) {
      invalidLines.push(token)
      continue
    }
    const n = Number.parseInt(clean, 10)
    if (Number.isInteger(n) && n > 0) {
      ids.push(n)
    } else {
      invalidLines.push(token)
    }
  }
  return { ids, invalidLines }
}
