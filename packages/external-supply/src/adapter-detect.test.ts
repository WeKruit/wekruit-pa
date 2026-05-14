/**
 * Adapter-detect heuristic unit tests.
 *
 * Mirrors the Wave B EXECUTOR-PLAN B test list:
 *  - golden juicebox / lessie / coresignal / unknown-csv detection.
 *  - filename-hint test: Lessie bytes named `juicebox-export.csv` -> Lessie wins.
 *  - empty buffer -> all < 0.6, top manual_csv.
 *  - determinism: same input -> identical output array.
 *  - xlsx -> manual_csv fallback + warning.
 */
import assert from "node:assert/strict"
import test from "node:test"
import {
  detectAdapter,
  type AdapterSignature,
} from "./adapter-detect.js"

const JUICEBOX_SIG: AdapterSignature = {
  source: "juicebox",
  requiredKeys: ["linkedin_url", "email_primary", "full_name"],
  bonusKeys: [
    "current_position",
    "current_company_name",
    "location_string",
    "experience_array",
    "education_array",
    "skills",
    "enrichment",
  ],
  acceptedShapes: ["json"],
  adapterVersion: "juicebox-2026-05-A",
}

const LESSIE_SIG: AdapterSignature = {
  source: "lessie",
  requiredKeys: ["linkedin url", "email", "name"],
  bonusKeys: ["title", "company", "location", "phone", "skills"],
  acceptedShapes: ["csv", "tsv"],
  adapterVersion: "lessie-2026-05-A",
}

const CORESIGNAL_SIG: AdapterSignature = {
  source: "coresignal",
  requiredKeys: ["profile.url", "contact.primary_email", "profile.full_name"],
  bonusKeys: [
    "profile.headline",
    "profile.location.name",
    "contact.phone",
    "experience",
    "education",
    "skills",
  ],
  acceptedShapes: ["json"],
  adapterVersion: "coresignal-2026-05-A",
}

const MANUAL_CSV_SIG: AdapterSignature = {
  source: "manual_csv",
  requiredKeys: [],
  bonusKeys: [],
  acceptedShapes: ["csv", "tsv"],
  adapterVersion: "manual-csv-2026-05-A",
}

const REGISTRY: AdapterSignature[] = [
  JUICEBOX_SIG,
  LESSIE_SIG,
  CORESIGNAL_SIG,
  MANUAL_CSV_SIG,
]

// ---------------------------------------------------------------------------
// Golden: juicebox
// ---------------------------------------------------------------------------

test("detectAdapter: juicebox JSON top hit + confidence >= 0.9", () => {
  const rows = [
    {
      linkedin_url: "https://linkedin.com/in/ada",
      email_primary: "ada@example.com",
      full_name: "Ada Lovelace",
      current_position: "Engineer",
      current_company_name: "Analytical",
      location_string: "London",
      skills: ["math"],
    },
    {
      linkedin_url: "https://linkedin.com/in/grace",
      email_primary: "grace@example.com",
      full_name: "Grace Hopper",
    },
    {
      linkedin_url: "https://linkedin.com/in/alan",
      email_primary: "alan@example.com",
      full_name: "Alan Turing",
    },
  ]
  const buf = Buffer.from(JSON.stringify(rows))
  const detection = detectAdapter({
    rawBytes: buf,
    filename: "juicebox-export.json",
    mime: "application/json",
    registry: REGISTRY,
  })
  assert.equal(detection.top.source, "juicebox")
  assert.ok(detection.top.confidence >= 0.9, `confidence=${detection.top.confidence}`)
  assert.equal(detection.shapeHint, "json")
  assert.equal(detection.warnings.length, 0)
})

// ---------------------------------------------------------------------------
// Golden: lessie
// ---------------------------------------------------------------------------

test("detectAdapter: lessie CSV top hit + confidence >= 0.9", () => {
  const csv = [
    "LinkedIn URL,Email,Name,Title,Company,Location,Phone,Skills",
    "https://linkedin.com/in/ada,ada@example.com,Ada Lovelace,Engineer,Analytical,London,+447700900000,math;analysis",
    "https://linkedin.com/in/grace,grace@example.com,Grace Hopper,Admiral,Navy,DC,+12025550000,cobol;flow",
  ].join("\n")
  const buf = Buffer.from(csv)
  const detection = detectAdapter({
    rawBytes: buf,
    filename: "lessie-export.csv",
    mime: "text/csv",
    registry: REGISTRY,
  })
  assert.equal(detection.top.source, "lessie")
  assert.ok(detection.top.confidence >= 0.9, `confidence=${detection.top.confidence}`)
  assert.equal(detection.shapeHint, "csv")
})

// ---------------------------------------------------------------------------
// Golden: coresignal (nested keys)
// ---------------------------------------------------------------------------

test("detectAdapter: coresignal JSON dotted-key top hit + confidence >= 0.9", () => {
  const rows = [
    {
      profile: {
        url: "https://linkedin.com/in/ada",
        full_name: "Ada Lovelace",
        headline: "Engineer",
        location: { name: "London" },
      },
      contact: {
        primary_email: "ada@example.com",
        phone: "+447700900000",
      },
      experience: [],
      education: [],
      skills: ["math"],
    },
  ]
  const buf = Buffer.from(JSON.stringify(rows))
  const detection = detectAdapter({
    rawBytes: buf,
    filename: "coresignal.json",
    mime: "application/json",
    registry: REGISTRY,
  })
  assert.equal(detection.top.source, "coresignal")
  assert.ok(detection.top.confidence >= 0.9, `confidence=${detection.top.confidence}`)
  assert.equal(detection.shapeHint, "json")
})

// ---------------------------------------------------------------------------
// Unknown CSV -> manual_csv floor in [0.5, 0.6)
// ---------------------------------------------------------------------------

test("detectAdapter: unknown CSV headers fall back to manual_csv floor", () => {
  const csv = "first_name,last_name,company\nAda,Lovelace,Analytical"
  const detection = detectAdapter({
    rawBytes: Buffer.from(csv),
    filename: "weird.csv",
    mime: "text/csv",
    registry: REGISTRY,
  })
  assert.equal(detection.top.source, "manual_csv")
  assert.ok(
    detection.top.confidence >= 0.5 && detection.top.confidence < 0.6,
    `confidence=${detection.top.confidence}`,
  )
  assert.equal(detection.shapeHint, "csv")
})

// ---------------------------------------------------------------------------
// Filename-hint cannot override shape penalty
// ---------------------------------------------------------------------------

test("detectAdapter: Lessie bytes named 'juicebox-export.csv' still picks lessie", () => {
  const csv = [
    "LinkedIn URL,Email,Name,Title,Company,Location,Phone,Skills",
    "https://linkedin.com/in/ada,ada@example.com,Ada Lovelace,Engineer,Analytical,London,+447700900000,math",
  ].join("\n")
  const detection = detectAdapter({
    rawBytes: Buffer.from(csv),
    filename: "juicebox-export.csv",
    mime: "text/csv",
    registry: REGISTRY,
  })
  // Juicebox requires JSON; with CSV shape it's penalized by 0.3 and gets 0
  // required matches anyway -> 0 floor. Lessie hits 3/3 required + ext hint.
  assert.equal(detection.top.source, "lessie")
  const juicebox = detection.candidates.find((c) => c.source === "juicebox")!
  assert.ok(juicebox.confidence < 0.6, `juicebox=${juicebox.confidence}`)
})

// ---------------------------------------------------------------------------
// Empty buffer -> all < 0.6, top manual_csv (no tokens, unknown shape)
// ---------------------------------------------------------------------------

test("detectAdapter: empty buffer -> all confidences < 0.6, top manual_csv", () => {
  const detection = detectAdapter({
    rawBytes: Buffer.alloc(0),
    registry: REGISTRY,
  })
  for (const c of detection.candidates) {
    assert.ok(c.confidence < 0.6, `${c.source}=${c.confidence}`)
  }
  assert.equal(detection.top.source, "manual_csv")
})

// ---------------------------------------------------------------------------
// xlsx -> manual_csv fallback + warning
// ---------------------------------------------------------------------------

test("detectAdapter: xlsx magic bytes emit warning + manual_csv fallback", () => {
  // PK\x03\x04 header is the xlsx (zip) magic.
  const buf = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from("garbage content"),
  ])
  const detection = detectAdapter({
    rawBytes: buf,
    filename: "candidates.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    registry: REGISTRY,
  })
  assert.equal(detection.shapeHint, "xlsx")
  assert.deepEqual(detection.warnings, ["xlsx_not_yet_supported"])
  assert.equal(detection.top.source, "manual_csv")
  assert.ok(detection.top.confidence < 0.6)
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("detectAdapter: identical input yields identical candidate array order", () => {
  const csv = [
    "LinkedIn URL,Email,Name,Title,Company,Location,Phone,Skills",
    "https://linkedin.com/in/ada,ada@example.com,Ada,Eng,Analytical,London,+447700900000,math",
  ].join("\n")
  const buf = Buffer.from(csv)
  const a = detectAdapter({ rawBytes: buf, filename: "x.csv", registry: REGISTRY })
  const b = detectAdapter({ rawBytes: buf, filename: "x.csv", registry: REGISTRY })
  assert.deepEqual(
    a.candidates.map((c) => [c.source, c.confidence]),
    b.candidates.map((c) => [c.source, c.confidence]),
  )
})

// ---------------------------------------------------------------------------
// Sanity: thresholds per L-B4 (lock 0.9, suggest 0.6-0.9, fallback <0.6)
// ---------------------------------------------------------------------------

test("detectAdapter: invalid JSON degrades to manual_csv fallback", () => {
  const buf = Buffer.from("{ not_json")
  const detection = detectAdapter({ rawBytes: buf, registry: REGISTRY })
  // shape detected as json (starts with `{`) but parse fails -> 0 tokens.
  assert.equal(detection.shapeHint, "json")
  // No adapter clears 0.6.
  for (const c of detection.candidates) {
    assert.ok(c.confidence < 0.6, `${c.source}=${c.confidence}`)
  }
})
