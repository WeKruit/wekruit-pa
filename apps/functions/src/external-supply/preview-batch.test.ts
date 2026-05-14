/**
 * Wave B / Block C — `runPreviewBatch` tests.
 *
 * Coverage:
 *  1. Zero-writes guard — recordingDb proxy throws on any `.set/.update/
 *     .add/.delete/.create` or `batch().*` invocation.
 *  2. Counter parity — preview against the V1 big-batch.json fixture yields
 *     `rowCount` / `validLinkedInCount` / `validEmailCount` /
 *     `withinBatchDuplicates` within ±5% of the V1 `runCreateBatch`
 *     post-commit numbers on the same fixture.
 *  3. Tag forecast determinism — two seeded `pa-users` (one with `skills`,
 *     one without) produce one `willPreserve['skills']` and one
 *     `willFill['skills']`.
 *  4. Tier forecast — totals == (rowCount - duplicates) and the tier keys
 *     match `EvaluationTierSchema`.
 *  5. Detection override — `overrideSource: "manual_csv"` skips detection.
 *  6. Warnings — rowCount > 1000 emits row warning; base64 > 3 MB emits
 *     base64 warning.
 *  7. Auth gate — non-admin throws `permission-denied`; missing auth
 *     throws `unauthenticated`.
 *  8. xlsx fallback — emits `xlsx_not_yet_supported` + chosenSource fallback.
 */

import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { HttpsError } from "firebase-functions/v2/https"
import type { Firestore } from "firebase-admin/firestore"
import {
  PA_COLLECTIONS,
  candidateHandleHashMaterial,
  createCandidateHandleId,
  type ExternalSource,
} from "@pa/core-types"
import { runPreviewBatch } from "./preview-batch.js"
import { runCreateBatch, batchStoragePath, type CreateBatchDeps } from "./import.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "../../../..")

const NOW = "2026-05-14T12:00:00.000Z"

const ADMIN_AUTH = { uid: "admin-uid", token: { admin: true as const } }
const WEKRUIT_AUTH = {
  uid: "wek-uid",
  token: { email: "ops@wekruit.com", email_verified: true },
}

function loadFixture(name: string): Buffer {
  return fs.readFileSync(path.join(REPO_ROOT, "tests/fixtures/external-supply", name))
}

// ---------------------------------------------------------------------------
// In-memory Firestore fake (mirrors the shape used by resolve-identity tests)
// ---------------------------------------------------------------------------

type Store = Map<string, Map<string, Record<string, unknown>>>

function makeStore(): Store {
  return new Map(Object.values(PA_COLLECTIONS).map((name) => [name, new Map()]))
}

function ensureCol(store: Store, name: string): Map<string, Record<string, unknown>> {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)!
}

function makeFakeFirestore(store: Store = makeStore()): { db: Firestore; store: Store } {
  let auto = 1
  function docRef(collectionName: string, id?: string) {
    const docId = id ?? `auto_${auto++}`
    return {
      id: docId,
      _collectionName: collectionName,
      _id: docId,
      async get() {
        const data = ensureCol(store, collectionName).get(docId)
        return { exists: data !== undefined, id: docId, data: () => data }
      },
      async set(data: Record<string, unknown>, opts?: { merge?: boolean }) {
        const current = ensureCol(store, collectionName).get(docId)
        ensureCol(store, collectionName).set(
          docId,
          opts?.merge && current ? { ...current, ...data } : { ...data },
        )
      },
    }
  }
  function collection(collectionName: string) {
    return {
      doc(id?: string) {
        return docRef(collectionName, id)
      },
      where(field: string, _op: string, value: unknown) {
        const entries = () =>
          Array.from(ensureCol(store, collectionName).entries()).filter(
            ([, data]) => data[field] === value,
          )
        return {
          async get() {
            const e = entries()
            return {
              empty: e.length === 0,
              docs: e.map(([id, data]) => ({ id, data: () => data })),
            }
          },
          limit() {
            return {
              async get() {
                const e = entries()
                return {
                  empty: e.length === 0,
                  docs: e.map(([id, data]) => ({ id, data: () => data })),
                }
              },
            }
          },
        }
      },
    }
  }
  function batch() {
    return {
      set: () => {},
      update: () => {},
      delete: () => {},
      async commit() {},
    }
  }
  const db = { collection, batch } as unknown as Firestore
  return { db, store }
}

// ---------------------------------------------------------------------------
// Recording proxy — wraps the Firestore fake and throws on ANY write.
// ---------------------------------------------------------------------------

const FORBIDDEN_WRITE_OPS = new Set(["set", "update", "add", "delete", "create", "commit"])
const FORBIDDEN_BATCH_OPS = new Set(["batch", "runTransaction"])

function makeRecordingDb<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === "function") {
        const propName = String(prop)
        return (...args: unknown[]) => {
          if (FORBIDDEN_WRITE_OPS.has(propName)) {
            throw new Error(`recordingDb_blocked_write_op:${propName}`)
          }
          if (FORBIDDEN_BATCH_OPS.has(propName)) {
            throw new Error(`recordingDb_blocked_op:${propName}`)
          }
          const result = (value as (...a: unknown[]) => unknown).apply(target, args)
          if (result && typeof result === "object" && !(result instanceof Promise)) {
            return makeRecordingDb(result as object)
          }
          return result
        }
      }
      if (value && typeof value === "object") {
        return makeRecordingDb(value as object)
      }
      return value
    },
  })
}

// ---------------------------------------------------------------------------
// Hashing + canonicalization helpers (inlined to keep this test free of the
// `tests/external-supply` workspace which lives outside `apps/functions`'
// rootDir.) These mirror the production normalizers in
// `packages/external-supply/src/normalize.ts`.
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function canonicalizeLinkedInUrl(raw: string): string {
  let url = raw.trim()
  if (/^\/\//.test(url)) url = `https:${url}`
  else if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  const parsed = new URL(url)
  let pathPart = parsed.pathname
  const localeMatch = /^\/[a-z]{2,3}\/in\//i.exec(pathPart)
  if (localeMatch) {
    pathPart = pathPart.slice(localeMatch[0].length - "/in/".length)
  }
  const m = /^\/in\/([A-Za-z0-9\-_%]+)\/?$/.exec(pathPart)
  if (!m) throw new Error(`canonicalizeLinkedInUrl:invalid:${raw}`)
  return `https://linkedin.com/in/${m[1]!.toLowerCase()}`
}

function linkedinHash(linkedinUrl: string): string {
  const canonical = canonicalizeLinkedInUrl(linkedinUrl)
  return sha256Hex(candidateHandleHashMaterial("linkedin", canonical))
}

function seedLinkedinHandle(store: Store, linkedinUrl: string, candidateId: string): void {
  const hash = linkedinHash(linkedinUrl)
  const handleId = createCandidateHandleId("linkedin", hash)
  ensureCol(store, PA_COLLECTIONS.candidateHandles).set(handleId, {
    handleId,
    candidateId,
    kind: "linkedin",
    handleHash: hash,
    normalizedValue: canonicalizeLinkedInUrl(linkedinUrl),
    source: "external_sourcing",
    verifiedAt: null,
    deliverable: false,
    createdAt: NOW,
  })
}

// ---------------------------------------------------------------------------
// Big-batch fixture grouping + serialization (inlined from
// tests/external-supply/helpers/seed.ts — same shapes the V1 adapters expect).
// ---------------------------------------------------------------------------

interface BigBatchRow {
  testCase: string
  adapter: "juicebox" | "lessie" | "coresignal"
  linkedin_url?: string | null
  email_primary?: string | null
  phone?: string | null
  full_name?: string | null
  current_position?: string | null
  current_company_name?: string | null
  location_string?: string | null
  experience_array?: Array<{ company?: string; title?: string; startDate?: string | null; endDate?: string | null }>
  education_array?: Array<{ school?: string; degree?: string | null; field?: string | null; endYear?: number | null }>
  skills?: string[]
}

function loadBigBatchFixture(): BigBatchRow[] {
  return JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "tests/fixtures/external-supply/big-batch.json"),
      "utf8",
    ),
  ) as BigBatchRow[]
}

function csvCell(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function serializeForAdapter(
  adapter: BigBatchRow["adapter"],
  rows: BigBatchRow[],
): string {
  switch (adapter) {
    case "juicebox":
      return JSON.stringify(
        rows.map((r) => ({
          linkedin_url: r.linkedin_url ?? null,
          email_primary: r.email_primary ?? null,
          phone: r.phone ?? null,
          full_name: r.full_name ?? null,
          current_position: r.current_position ?? null,
          current_company_name: r.current_company_name ?? null,
          location_string: r.location_string ?? null,
          experience_array: r.experience_array ?? [],
          education_array: r.education_array ?? [],
          skills: r.skills ?? [],
        })),
      )
    case "lessie": {
      const header = ["LinkedIn URL", "Email", "Name", "Title", "Company", "Location", "Phone", "Skills"]
      const lines: string[] = [header.join(",")]
      for (const r of rows) {
        const cells = [
          r.linkedin_url ?? "",
          r.email_primary ?? "",
          r.full_name ?? "",
          r.current_position ?? "",
          r.current_company_name ?? "",
          r.location_string ?? "",
          r.phone ?? "",
          (r.skills ?? []).join("; "),
        ]
        lines.push(cells.map(csvCell).join(","))
      }
      return lines.join("\n")
    }
    case "coresignal":
      return JSON.stringify(
        rows.map((r) => ({
          profile: {
            url: r.linkedin_url ?? null,
            full_name: r.full_name ?? null,
            headline: r.current_position ?? null,
            location: { name: r.location_string ?? null },
          },
          contact: {
            primary_email: r.email_primary ?? null,
            phone: r.phone ?? null,
          },
          experience: (r.experience_array ?? []).map((e) => ({
            company_name: e.company ?? null,
            title: e.title ?? null,
            date_from: e.startDate ?? null,
            date_to: e.endDate ?? null,
          })),
          education: (r.education_array ?? []).map((ed) => ({
            school: ed.school ?? null,
            degree: ed.degree ?? null,
            field_of_study: ed.field ?? null,
            date_to: ed.endYear ? String(ed.endYear) : null,
          })),
          skills: r.skills ?? [],
        })),
      )
  }
}

function rowsByAdapter(rows: BigBatchRow[]): Array<{
  adapter: BigBatchRow["adapter"]
  rows: BigBatchRow[]
  serialized: string
  mime: string
}> {
  const groups: Record<BigBatchRow["adapter"], BigBatchRow[]> = {
    juicebox: [],
    lessie: [],
    coresignal: [],
  }
  for (const row of rows) {
    groups[row.adapter].push(row)
  }
  const out: Array<{
    adapter: BigBatchRow["adapter"]
    rows: BigBatchRow[]
    serialized: string
    mime: string
  }> = []
  for (const adapter of ["juicebox", "lessie", "coresignal"] as const) {
    const groupRows = groups[adapter]
    if (groupRows.length === 0) continue
    out.push({
      adapter,
      rows: groupRows,
      serialized: serializeForAdapter(adapter, groupRows),
      mime: adapter === "lessie" ? "text/csv" : "application/json",
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. Zero-writes guard
// ---------------------------------------------------------------------------

test("runPreviewBatch — zero Firestore writes against the big-batch fixture", async () => {
  const rows = loadBigBatchFixture()
  const groups = rowsByAdapter(rows)
  const juiceboxGroup = groups.find((g) => g.adapter === "juicebox")
  assert.ok(juiceboxGroup, "fixture has juicebox rows")
  const base64Bytes = Buffer.from(juiceboxGroup!.serialized, "utf8").toString("base64")

  const { db } = makeFakeFirestore()
  const recordingDb = makeRecordingDb(db)

  const result = await runPreviewBatch(
    {
      filename: "juicebox.json",
      mime: "application/json",
      base64Bytes,
    },
    ADMIN_AUTH,
    { db: recordingDb, now: () => NOW },
  )

  assert.equal(result.chosenSource, "juicebox")
  assert.ok(result.rowCount > 0, "should parse rows")
})

// ---------------------------------------------------------------------------
// 2. Counter parity vs V1 runCreateBatch
// ---------------------------------------------------------------------------

interface V1Counts {
  rowCount: number
  validLinkedInCount: number
  validEmailCount: number
  duplicateCount: number
}

function makeImportDeps(blobs: Map<string, Buffer>): CreateBatchDeps {
  return {
    async downloadFile(uri) {
      const b = blobs.get(uri)
      if (!b) throw new Error(`missing:${uri}`)
      return b
    },
    async findExistingBatch() {
      return null
    },
    async writeBatchAndRecords() {
      // intentional no-op — only need returned stats for parity.
    },
    now: () => NOW,
    newId: (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
  }
}

async function v1Counts(source: ExternalSource, serialized: string, mime: string): Promise<V1Counts> {
  const fixture = Buffer.from(serialized, "utf8")
  const sha256 = `parity_${source}_${fixture.length.toString(16)}_${"0".repeat(40)}`
  const uri = `gs://test/${batchStoragePath(source, sha256, mime)}`
  const blobs = new Map<string, Buffer>([[uri, fixture]])
  const out = await runCreateBatch(
    { source, storageUri: uri, sha256, mime, sizeBytes: fixture.length, importedBy: "parity" },
    makeImportDeps(blobs),
  )
  return {
    rowCount: out.rowCount,
    validLinkedInCount: out.validLinkedInCount,
    validEmailCount: out.validEmailCount,
    duplicateCount: out.duplicateCount,
  }
}

function withinFivePercent(preview: number, v1: number): boolean {
  if (v1 === 0) return preview === 0
  const delta = Math.abs(preview - v1)
  return delta / Math.max(1, v1) <= 0.05
}

test("runPreviewBatch — counter parity with V1 runCreateBatch on big-batch fixture", async () => {
  const rows = loadBigBatchFixture()
  const groups = rowsByAdapter(rows)

  for (const group of groups) {
    const base64Bytes = Buffer.from(group.serialized, "utf8").toString("base64")

    const { db } = makeFakeFirestore()
    const recordingDb = makeRecordingDb(db)
    const preview = await runPreviewBatch(
      {
        filename: `${group.adapter}.${group.mime === "text/csv" ? "csv" : "json"}`,
        mime: group.mime,
        base64Bytes,
      },
      ADMIN_AUTH,
      { db: recordingDb, now: () => NOW },
    )
    const v1 = await v1Counts(group.adapter, group.serialized, group.mime)

    assert.ok(
      withinFivePercent(preview.rowCount, v1.rowCount),
      `${group.adapter} rowCount parity: preview=${preview.rowCount} v1=${v1.rowCount}`,
    )
    assert.ok(
      withinFivePercent(preview.validLinkedInCount, v1.validLinkedInCount),
      `${group.adapter} validLinkedInCount parity: preview=${preview.validLinkedInCount} v1=${v1.validLinkedInCount}`,
    )
    assert.ok(
      withinFivePercent(preview.validEmailCount, v1.validEmailCount),
      `${group.adapter} validEmailCount parity: preview=${preview.validEmailCount} v1=${v1.validEmailCount}`,
    )
    assert.ok(
      withinFivePercent(preview.withinBatchDuplicates, v1.duplicateCount),
      `${group.adapter} withinBatchDuplicates parity: preview=${preview.withinBatchDuplicates} v1=${v1.duplicateCount}`,
    )
  }
})

// ---------------------------------------------------------------------------
// 3. Tag forecast determinism
// ---------------------------------------------------------------------------

test("runPreviewBatch — tag forecast: existing 'recentRoleTitle' is preserved, missing 'recentRoleTitle' is filled", async () => {
  // Two LinkedIn URLs → two existing pa-users. Alice already has a strong
  // `recentRoleTitle`; Bob does not. The bridge should preserve Alice's value
  // and weak-fill Bob's. We avoid `skills` because the bridge intentionally
  // does NOT derive `skills` from external rows (skills come from CV/chat).
  const rows = [
    {
      linkedin_url: "https://linkedin.com/in/alice-hastitle-001",
      email_primary: "alice@example.test",
      full_name: "Alice Has-Title",
      current_position: "Software Engineer",
      current_company_name: "Acme",
      location_string: "Remote",
      experience_array: [{ company: "Acme", title: "Software Engineer" }],
    },
    {
      linkedin_url: "https://linkedin.com/in/bob-notitle-002",
      email_primary: "bob@example.test",
      full_name: "Bob No-Title",
      current_position: "Software Engineer",
      current_company_name: "Acme",
      location_string: "Remote",
      experience_array: [{ company: "Acme", title: "Software Engineer" }],
    },
  ]
  const payload = JSON.stringify(rows)
  const base64Bytes = Buffer.from(payload, "utf8").toString("base64")

  const { db, store } = makeFakeFirestore()

  ensureCol(store, PA_COLLECTIONS.users).set("cand-alice", {
    candidateId: "cand-alice",
    tags: {
      recentRoleTitle: "Principal Engineer (CV)",
      schemaVersion: 1,
    },
  })
  ensureCol(store, PA_COLLECTIONS.users).set("cand-bob", {
    candidateId: "cand-bob",
    tags: { schemaVersion: 1 },
  })
  seedLinkedinHandle(store, rows[0]!.linkedin_url, "cand-alice")
  seedLinkedinHandle(store, rows[1]!.linkedin_url, "cand-bob")

  const recordingDb = makeRecordingDb(db)
  const result = await runPreviewBatch(
    { filename: "two.json", mime: "application/json", base64Bytes },
    ADMIN_AUTH,
    { db: recordingDb, now: () => NOW },
  )

  assert.equal(
    result.identityForecast.mergeExisting,
    2,
    "both LinkedIn handles resolve to existing candidates",
  )
  assert.equal(
    result.tagEnrichmentForecast.perFieldPreservedCount.recentRoleTitle,
    1,
    "alice preserves recentRoleTitle",
  )
  assert.equal(
    result.tagEnrichmentForecast.perFieldFillCount.recentRoleTitle,
    1,
    "bob fills recentRoleTitle",
  )
  assert.equal(result.tagEnrichmentForecast.perCandidatePreview.length, 2)
})

// ---------------------------------------------------------------------------
// 4. Tier forecast
// ---------------------------------------------------------------------------

test("runPreviewBatch — tier forecast keys match EvaluationTierSchema; totals == valid rows", async () => {
  const fixture = loadFixture("juicebox-sample.json")
  const base64Bytes = fixture.toString("base64")

  const { db, store } = makeFakeFirestore()
  ensureCol(store, "pa-jobs").set("job-preview-1", {
    jobId: "job-preview-1",
    title: "Software Engineer",
    roleFunction: ["software_engineering"],
    requiredSkills: ["python", "typescript"],
    seniorityLevel: "mid",
    locationBuckets: ["remote_united_states"],
    sponsorship: true,
    jobType: "full_time",
    industrySector: ["artificial_intelligence_and_machine_learning"],
    firstSeenAt: "2026-05-01T00:00:00.000Z",
  })
  ensureCol(store, "pa-companies").set("co-preview-1", {
    companyId: "co-preview-1",
    name: "Preview Co",
    industrySector: ["artificial_intelligence_and_machine_learning"],
    size: "scale_up",
  })

  const recordingDb = makeRecordingDb(db)
  const result = await runPreviewBatch(
    {
      filename: "juicebox-sample.json",
      mime: "application/json",
      base64Bytes,
      forecastEvaluationFor: { companyId: "co-preview-1", jobId: "job-preview-1" },
    },
    ADMIN_AUTH,
    { db: recordingDb, now: () => NOW },
  )

  assert.ok(result.tierForecast, "tierForecast must be present when forecastEvaluationFor supplied")
  const tier = result.tierForecast!
  assert.equal(typeof tier.tier_1_personal_linkedin_and_email, "number")
  assert.equal(typeof tier.tier_2_personal_email, "number")
  assert.equal(typeof tier.tier_3_general_email, "number")
  assert.equal(typeof tier.retain_only, "number")
  assert.equal(typeof tier.blocked, "number")

  const tierTotal =
    tier.tier_1_personal_linkedin_and_email +
    tier.tier_2_personal_email +
    tier.tier_3_general_email +
    tier.retain_only +
    tier.blocked

  const expectedParticipants = result.rowCount - result.withinBatchDuplicates
  assert.equal(
    tierTotal,
    expectedParticipants,
    `tier totals == rowCount-duplicates (${tierTotal} != ${expectedParticipants})`,
  )
})

// ---------------------------------------------------------------------------
// 5. Detection override
// ---------------------------------------------------------------------------

test("runPreviewBatch — overrideSource short-circuits detection", async () => {
  // Use Lessie CSV but force manual_csv.
  const fixture = loadFixture("lessie-sample.csv")
  const base64Bytes = fixture.toString("base64")

  const { db } = makeFakeFirestore()
  const recordingDb = makeRecordingDb(db)

  const result = await runPreviewBatch(
    {
      filename: "lessie-sample.csv",
      mime: "text/csv",
      base64Bytes,
      overrideSource: "manual_csv",
      columnMapping: {
        linkedinUrl: "LinkedIn URL",
        email: "Email",
        name: "Name",
        currentTitle: "Title",
        currentCompany: "Company",
        location: "Location",
      },
    },
    ADMIN_AUTH,
    { db: recordingDb, now: () => NOW },
  )

  assert.equal(result.chosenSource, "manual_csv")
  assert.ok(Array.isArray(result.detection))
})

// ---------------------------------------------------------------------------
// 6. Warnings
// ---------------------------------------------------------------------------

test("runPreviewBatch — emits 'base64_size_warning_over_3mb' when payload exceeds 3 MB", async () => {
  // Build a juicebox payload large enough that the base64 is > 3 MB.
  // We pad with extra rows so the actual parse still works.
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < 12_000; i += 1) {
    rows.push({
      linkedin_url: `https://linkedin.com/in/pad-${i}`,
      email_primary: `pad-${i}@example.test`,
      full_name: `Pad ${i}`,
      current_position: "Software Engineer",
      current_company_name: "Pad Co",
      location_string: "Remote",
      skills: ["python", "typescript"],
    })
  }
  const payload = JSON.stringify(rows)
  const base64Bytes = Buffer.from(payload, "utf8").toString("base64")
  assert.ok(
    base64Bytes.length > 3_000_000,
    `expected base64 > 3 MB; got ${base64Bytes.length}`,
  )

  const { db } = makeFakeFirestore()
  const recordingDb = makeRecordingDb(db)
  const result = await runPreviewBatch(
    {
      filename: "big.json",
      mime: "application/json",
      base64Bytes,
      overrideSource: "juicebox",
    },
    ADMIN_AUTH,
    { db: recordingDb, now: () => NOW },
  )
  assert.ok(
    result.warnings.includes("base64_size_warning_over_3mb"),
    `expected size warning; got: ${result.warnings.join(",")}`,
  )
})

test("runPreviewBatch — emits 'row_count_warning_over_1000' when rowCount > 1000", async () => {
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < 1100; i += 1) {
    rows.push({
      linkedin_url: `https://linkedin.com/in/synth-${i}`,
      email_primary: `synth-${i}@example.test`,
      full_name: `Synth ${i}`,
      current_position: "Software Engineer",
      current_company_name: "Synth Co",
      location_string: "Remote",
      skills: ["python"],
    })
  }
  const payload = JSON.stringify(rows)
  const base64Bytes = Buffer.from(payload, "utf8").toString("base64")

  const { db } = makeFakeFirestore()
  const recordingDb = makeRecordingDb(db)
  const result = await runPreviewBatch(
    { filename: "synth.json", mime: "application/json", base64Bytes },
    ADMIN_AUTH,
    { db: recordingDb, now: () => NOW },
  )
  assert.ok(result.rowCount >= 1000, `synth produced ${result.rowCount} rows`)
  assert.ok(
    result.warnings.includes("row_count_warning_over_1000"),
    `expected row-count warning; got: ${result.warnings.join(",")}`,
  )
})

// ---------------------------------------------------------------------------
// 7. Auth gate
// ---------------------------------------------------------------------------

test("runPreviewBatch — rejects unauthenticated callers", async () => {
  const { db } = makeFakeFirestore()
  const recordingDb = makeRecordingDb(db)
  await assert.rejects(
    () =>
      runPreviewBatch(
        {
          filename: "x.json",
          mime: "application/json",
          base64Bytes: Buffer.from("[]", "utf8").toString("base64"),
        },
        undefined,
        { db: recordingDb, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "unauthenticated",
  )
})

test("runPreviewBatch — rejects non-wekruit email", async () => {
  const { db } = makeFakeFirestore()
  const recordingDb = makeRecordingDb(db)
  await assert.rejects(
    () =>
      runPreviewBatch(
        {
          filename: "x.json",
          mime: "application/json",
          base64Bytes: Buffer.from("[]", "utf8").toString("base64"),
        },
        { uid: "x", token: { email: "outsider@gmail.com", email_verified: true } },
        { db: recordingDb, now: () => NOW },
      ),
    (err) => err instanceof HttpsError && err.code === "permission-denied",
  )
})

test("runPreviewBatch — wekruit.com email passes auth gate", async () => {
  const { db } = makeFakeFirestore()
  const recordingDb = makeRecordingDb(db)
  const result = await runPreviewBatch(
    {
      filename: "empty.json",
      mime: "application/json",
      base64Bytes: Buffer.from("[]", "utf8").toString("base64"),
    },
    WEKRUIT_AUTH,
    { db: recordingDb, now: () => NOW },
  )
  assert.equal(result.rowCount, 0)
})

// ---------------------------------------------------------------------------
// 8. xlsx fallback
// ---------------------------------------------------------------------------

test("runPreviewBatch — xlsx without columnMapping returns 0 rows + xlsx_not_yet_supported warning", async () => {
  // PK\x03\x04 magic — detected as xlsx shape.
  const xlsxStub = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00])
  const base64Bytes = xlsxStub.toString("base64")

  const { db } = makeFakeFirestore()
  const recordingDb = makeRecordingDb(db)
  const result = await runPreviewBatch(
    {
      filename: "uploaded.xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64Bytes,
    },
    ADMIN_AUTH,
    { db: recordingDb, now: () => NOW },
  )
  assert.equal(result.chosenSource, "manual_csv")
  assert.equal(result.rowCount, 0)
  assert.ok(
    result.warnings.includes("xlsx_not_yet_supported"),
    `expected xlsx warning; got: ${result.warnings.join(",")}`,
  )
})
