/**
 * parseSheetToRows covers three on-the-wire input shapes the dashboard
 * dropzone accepts. CSV is the historical default; xlsx unlocks Lessie
 * exports (Adam's primary external supply source); TSV is the long tail.
 *
 * Tests run against literal buffers — no fixtures on disk — so the suite
 * stays hermetic.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import * as XLSX from "xlsx"
import { parseSheetToRows, sniffSheetKind } from "./sheet.js"

function buildXlsxBuffer(headers: string[], rows: string[][]): Buffer {
  const aoa = [headers, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1")
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer
}

test("parseSheetToRows CSV — header order preserved, blank lines skipped", () => {
  const buf = Buffer.from(
    [
      "Name,Link,Email",
      "Alice,https://linkedin.com/in/alice,alice@example.com",
      "",
      "Bob,https://linkedin.com/in/bob,bob@example.com",
    ].join("\n"),
  )
  const r = parseSheetToRows(buf, "csv")
  assert.deepEqual(r.headers, ["Name", "Link", "Email"])
  assert.equal(r.rows.length, 2)
  assert.equal(r.rows[0]!.Name, "Alice")
  assert.equal(r.rows[1]!.Email, "bob@example.com")
})

test("parseSheetToRows TSV — tab delimited", () => {
  const buf = Buffer.from(["a\tb\tc", "1\t2\t3"].join("\n"))
  const r = parseSheetToRows(buf, "tsv")
  assert.deepEqual(r.headers, ["a", "b", "c"])
  assert.equal(r.rows[0]!.b, "2")
})

test("parseSheetToRows XLSX — round-trips a Lessie-shaped sheet", () => {
  const headers = [
    "Name",
    "Link",
    "Email",
    "Match",
    "Company",
    "Headline",
    "Title",
    "Country/Region",
    "Solana Expertise",
  ]
  const buf = buildXlsxBuffer(headers, [
    [
      "Alice Smith",
      "https://linkedin.com/in/alicesmith",
      "alice@example.com",
      "0.84",
      "Acme",
      "Senior SWE",
      "Senior Software Engineer",
      "United States",
      "✅ 4+ years Solana production",
    ],
    [
      "Bob Jones",
      "https://linkedin.com/in/bobjones",
      "bob@example.com",
      "0.62",
      "Globex",
      "Backend Lead",
      "Engineering Lead",
      "United States",
      "❌ No production Solana",
    ],
  ])
  const r = parseSheetToRows(buf, "xlsx")
  assert.deepEqual(r.headers, headers)
  assert.equal(r.rows.length, 2)
  assert.equal(r.rows[0]!["Solana Expertise"], "✅ 4+ years Solana production")
  assert.equal(r.rows[1]!.Company, "Globex")
})

test("sniffSheetKind — detects xlsx by extension + by magic bytes", () => {
  assert.equal(sniffSheetKind("foo.xlsx", Buffer.from("anything")), "xlsx")
  const pkMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
  assert.equal(sniffSheetKind("unknown", pkMagic), "xlsx")
  assert.equal(sniffSheetKind("data.tsv", Buffer.from("a\tb")), "tsv")
  assert.equal(sniffSheetKind("data.csv", Buffer.from("a,b")), "csv")
  assert.equal(sniffSheetKind("data", Buffer.from("a,b")), "csv") // fallback
})
