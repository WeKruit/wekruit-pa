/**
 * Loose sheet parser — CSV / TSV / XLSX → `{ headers, rows }`.
 *
 * Used by the manual-csv adapter + preview-batch handler to accept any
 * tabular file without an operator-supplied column mapping. The auto-map
 * util (`./auto-map.ts`) consumes the headers to infer canonical fields.
 *
 * XLSX path uses sheetjs (`xlsx`) with `cellDates: false` so dates stay
 * formatted strings — keeps the wire payload deterministic for tests.
 * CSV / TSV path delegates to `csv-parse/sync` (already a transitive dep).
 */
import { parse as csvParse } from "csv-parse/sync"
import * as XLSX from "xlsx"

export type SheetKind = "csv" | "tsv" | "xlsx"

export interface ParsedSheet {
  headers: string[]
  rows: Record<string, string>[]
}

function trimHeader(h: unknown): string {
  if (h === null || h === undefined) return ""
  const s = String(h).trim()
  return s.replace(/^"(.*)"$/, "$1").trim()
}

function csvOrTsv(text: string, delim: string): ParsedSheet {
  const records = csvParse(text, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    delimiter: delim,
  }) as Record<string, string>[]
  const headers: string[] =
    records.length > 0
      ? Object.keys(records[0] ?? {}).map(trimHeader).filter((h) => h.length > 0)
      : []
  return { headers, rows: records }
}

function parseXlsx(buf: Buffer): ParsedSheet {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false })
  const firstSheetName = wb.SheetNames[0]
  if (!firstSheetName) return { headers: [], rows: [] }
  const ws = wb.Sheets[firstSheetName]
  if (!ws) return { headers: [], rows: [] }
  // header:1 returns an array-of-arrays so we can capture the literal first
  // row exactly. Then build header-keyed row objects ourselves.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: false,
  })
  if (matrix.length === 0) return { headers: [], rows: [] }
  const headerRow = matrix[0]!.map(trimHeader)
  const seen = new Set<string>()
  const headers: string[] = []
  // Dedupe header names — sheetjs preserves duplicate columns as-is, which
  // breaks a `Record<header, value>` shape. Suffix dupes with `_2`, `_3`.
  for (const h of headerRow) {
    if (h.length === 0) {
      headers.push("")
      continue
    }
    if (!seen.has(h)) {
      headers.push(h)
      seen.add(h)
      continue
    }
    let i = 2
    while (seen.has(`${h}_${i}`)) i += 1
    const suffixed = `${h}_${i}`
    headers.push(suffixed)
    seen.add(suffixed)
  }
  const rows: Record<string, string>[] = []
  for (let r = 1; r < matrix.length; r += 1) {
    const raw = matrix[r] ?? []
    // Skip rows that are entirely blank/empty strings.
    const nonEmpty = raw.some((v) => v !== "" && v !== null && v !== undefined)
    if (!nonEmpty) continue
    const obj: Record<string, string> = {}
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c]
      if (!key) continue
      const cell = raw[c]
      obj[key] = cell === null || cell === undefined ? "" : String(cell)
    }
    rows.push(obj)
  }
  return { headers: headers.filter((h) => h.length > 0), rows }
}

/**
 * Parse a sheet buffer of the given kind. Returns the header array (in
 * source order) plus row records keyed by header. Empty input yields
 * `{ headers: [], rows: [] }` rather than throwing — the caller decides
 * whether that's an error.
 */
export function parseSheetToRows(buf: Buffer, kind: SheetKind): ParsedSheet {
  if (kind === "xlsx") return parseXlsx(buf)
  const text = buf.toString("utf8").replace(/^﻿/, "")
  if (text.trim().length === 0) return { headers: [], rows: [] }
  return csvOrTsv(text, kind === "tsv" ? "\t" : ",")
}

/**
 * Sniff the sheet kind from a filename + raw buffer. Falls back to CSV when
 * unsure so the caller still gets a parse attempt.
 */
export function sniffSheetKind(filename: string, buf: Buffer): SheetKind {
  if (/\.xlsx$/i.test(filename)) return "xlsx"
  if (/\.tsv$/i.test(filename)) return "tsv"
  if (buf.length >= 4) {
    const magic = buf.subarray(0, 4)
    if (magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04) {
      return "xlsx"
    }
  }
  return "csv"
}
