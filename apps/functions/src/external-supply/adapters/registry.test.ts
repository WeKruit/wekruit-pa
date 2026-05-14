/**
 * Adapter registry tests — verify the registry behaves as a drop-in for V1's
 * hard-coded switch dispatch:
 *
 *  - getAdapter(source).parse(buf) === parseXExport(buf.toString("utf8"))
 *  - manual_csv throws the exact V1 error string when columnMapping is absent
 *  - getRegistrySignatures() exposes 4 entries in canonical order
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  ADAPTER_REGISTRY,
  getAdapter,
  getRegistrySignatures,
} from "./registry.js"
import { parseJuiceboxExport } from "./juicebox.js"
import { parseLessieExport } from "./lessie.js"
import { parseCoresignalExport } from "./coresignal.js"
import { parseManualCsvExport, type ManualCsvColumnMapping } from "./manual-csv.js"

// ---------------------------------------------------------------------------
// Parity — juicebox
// ---------------------------------------------------------------------------

test("registry.juicebox.parse === parseJuiceboxExport(toString)", () => {
  const rows = [
    {
      linkedin_url: "https://linkedin.com/in/ada",
      email_primary: "ada@example.com",
      full_name: "Ada Lovelace",
    },
  ]
  const buf = Buffer.from(JSON.stringify(rows))
  const viaRegistry = getAdapter("juicebox").parse(buf)
  const viaDirect = parseJuiceboxExport(buf.toString("utf8"))
  assert.deepEqual(viaRegistry, viaDirect)
})

// ---------------------------------------------------------------------------
// Parity — lessie
// ---------------------------------------------------------------------------

test("registry.lessie.parse === parseLessieExport(toString)", () => {
  const csv = [
    "LinkedIn URL,Email,Name,Title,Company,Location,Phone,Skills",
    "https://linkedin.com/in/ada,ada@example.com,Ada Lovelace,Engineer,Analytical,London,,",
  ].join("\n")
  const buf = Buffer.from(csv)
  const viaRegistry = getAdapter("lessie").parse(buf)
  const viaDirect = parseLessieExport(buf.toString("utf8"))
  assert.deepEqual(viaRegistry, viaDirect)
})

// ---------------------------------------------------------------------------
// Parity — coresignal
// ---------------------------------------------------------------------------

test("registry.coresignal.parse === parseCoresignalExport(toString)", () => {
  const rows = [
    {
      profile: {
        url: "https://linkedin.com/in/ada",
        full_name: "Ada Lovelace",
        headline: "Engineer",
      },
      contact: { primary_email: "ada@example.com" },
    },
  ]
  const buf = Buffer.from(JSON.stringify(rows))
  const viaRegistry = getAdapter("coresignal").parse(buf)
  const viaDirect = parseCoresignalExport(buf.toString("utf8"))
  assert.deepEqual(viaRegistry, viaDirect)
})

// ---------------------------------------------------------------------------
// Parity — manual_csv with columnMapping
// ---------------------------------------------------------------------------

test("registry.manual_csv.parse(buf, mapping) === parseManualCsvExport(toString, mapping)", () => {
  const csv = [
    "li,em,nm",
    "https://linkedin.com/in/ada,ada@example.com,Ada",
  ].join("\n")
  const mapping: ManualCsvColumnMapping = {
    linkedinUrl: "li",
    email: "em",
    name: "nm",
  }
  const buf = Buffer.from(csv)
  const viaRegistry = getAdapter("manual_csv").parse(buf, mapping)
  const viaDirect = parseManualCsvExport(buf.toString("utf8"), mapping)
  assert.deepEqual(viaRegistry, viaDirect)
})

// ---------------------------------------------------------------------------
// manual_csv requires column mapping — V1 error string preserved verbatim
// ---------------------------------------------------------------------------

test("registry.manual_csv.parse(buf) without mapping throws V1 error string", () => {
  const buf = Buffer.from("a,b,c\n1,2,3")
  assert.throws(
    () => getAdapter("manual_csv").parse(buf),
    /^Error: manual_csv_requires_columnMapping$/,
  )
})

// ---------------------------------------------------------------------------
// Registry shape + ordering
// ---------------------------------------------------------------------------

test("getRegistrySignatures has 4 entries in canonical order", () => {
  const sigs = getRegistrySignatures()
  assert.equal(sigs.length, 4)
  assert.deepEqual(
    sigs.map((s) => s.source),
    ["juicebox", "lessie", "coresignal", "manual_csv"],
  )
})

test("ADAPTER_REGISTRY exposes all four sources with version + signature", () => {
  for (const src of ["juicebox", "lessie", "coresignal", "manual_csv"] as const) {
    const d = ADAPTER_REGISTRY[src]
    assert.equal(d.source, src)
    assert.equal(typeof d.adapterVersion, "string")
    assert.equal(d.signature.source, src)
    assert.equal(typeof d.parse, "function")
  }
})

test("getAdapter('juicebox').signature.acceptedShapes is ['json']", () => {
  assert.deepEqual(getAdapter("juicebox").signature.acceptedShapes, ["json"])
})
