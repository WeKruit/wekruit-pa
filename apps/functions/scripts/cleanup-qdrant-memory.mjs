#!/usr/bin/env node
/**
 * 2026-05-18 pre-launch cleanup — drain Qdrant `pa_memory` +
 * `pa_memory_entities` of every user_id payload NOT in KEEP_LIST.
 *
 * Goal: .planning/GOAL-pa-users-cleanup.md (step 3).
 *
 * Strategy:
 *   1. For each Qdrant collection (`pa_memory`, `pa_memory_entities`):
 *      - Count points with filter `must_not: user_id ∈ KEEP_LIST` to surface
 *        the would-delete count before any destructive write.
 *      - In --execute mode, POST /points/delete with the same filter so the
 *        server-side delete is atomic; no scroll-and-paginate needed.
 *   2. `memory_migrations` is NEVER touched (schema metadata, no user data).
 *
 * Usage:
 *   QDRANT_URL=https://...:443 QDRANT_API_KEY=... \
 *   node apps/functions/scripts/cleanup-qdrant-memory.mjs --dry-run
 *
 *   QDRANT_URL=https://...:443 QDRANT_API_KEY=... \
 *   node apps/functions/scripts/cleanup-qdrant-memory.mjs --execute
 *
 * Note: Qdrant filter syntax for "user_id ∉ KEEP_LIST":
 *   { must_not: [ { key: "user_id", match: { any: [...KEEP_LIST] } } ] }
 */

const KEEP_LIST = [
  "U7AwKT8nLDRa35DkuBxq",
  "UThMpnAGzjaWnxDsKEMH",
  "itYEwzaJjVPjWbN01fzk",
]

const COLLECTIONS = ["pa_memory", "pa_memory_entities"]

const args = process.argv.slice(2)
const DRY_RUN = args.includes("--dry-run")
const EXECUTE = args.includes("--execute")

if (DRY_RUN === EXECUTE) {
  console.error("usage: pass EXACTLY ONE of --dry-run or --execute")
  console.error("  --dry-run    count without deleting")
  console.error("  --execute    delete (only after dry-run + Adam confirm)")
  process.exit(2)
}

const QDRANT_URL = (process.env.QDRANT_URL ?? "").trim().replace(/\/+$/, "")
const QDRANT_API_KEY = (process.env.QDRANT_API_KEY ?? "").trim()

if (!QDRANT_URL || !QDRANT_API_KEY) {
  console.error("FAIL — QDRANT_URL and QDRANT_API_KEY are required (cannot proceed)")
  process.exit(2)
}

const headers = {
  "api-key": QDRANT_API_KEY,
  "content-type": "application/json",
}

const filterDeletable = {
  must_not: [
    {
      key: "user_id",
      match: { any: KEEP_LIST },
    },
  ],
}

const filterKeep = {
  must: [
    {
      key: "user_id",
      match: { any: KEEP_LIST },
    },
  ],
}

async function postJson(path, body) {
  const r = await fetch(`${QDRANT_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    throw new Error(`${path} ${r.status}: ${await r.text()}`)
  }
  return r.json()
}

async function countWithFilter(collection, filter) {
  const j = await postJson(`/collections/${collection}/points/count`, {
    filter,
    exact: true,
  })
  return j.result?.count ?? 0
}

async function deletePointsByFilter(collection, filter) {
  return postJson(`/collections/${collection}/points/delete?wait=true`, {
    filter,
  })
}

async function main() {
  console.log("=".repeat(72))
  console.log(`Qdrant cleanup — mode: ${DRY_RUN ? "DRY-RUN" : "EXECUTE"}`)
  console.log(`KEEP_LIST: ${KEEP_LIST.join(", ")}`)
  console.log(`Endpoint: ${QDRANT_URL}`)
  console.log("=".repeat(72))
  console.log("")

  const summary = []
  for (const collection of COLLECTIONS) {
    let totalBefore, deletable, keepers
    try {
      const r = await postJson(`/collections/${collection}`, {})
      totalBefore = r.result?.points_count ?? null
    } catch (err) {
      console.log(`  ${collection.padEnd(28)}  [collection-not-found / ${err.message}]`)
      summary.push({ collection, error: err.message })
      continue
    }
    deletable = await countWithFilter(collection, filterDeletable)
    keepers = await countWithFilter(collection, filterKeep)

    if (DRY_RUN) {
      console.log(
        `  ${collection.padEnd(28)}  total=${String(totalBefore).padStart(6)} ` +
        `would-delete=${String(deletable).padStart(6)} ` +
        `keepers=${String(keepers).padStart(4)}`
      )
      summary.push({ collection, totalBefore, deletable, keepers, deleted: 0 })
      continue
    }

    if (deletable === 0) {
      console.log(`  ${collection.padEnd(28)}  total=${String(totalBefore).padStart(6)} (nothing to delete)`)
      summary.push({ collection, totalBefore, deletable: 0, keepers, deleted: 0 })
      continue
    }

    await deletePointsByFilter(collection, filterDeletable)

    const totalAfter = (await postJson(`/collections/${collection}`, {})).result?.points_count ?? null
    const keepersAfter = await countWithFilter(collection, filterKeep)
    const deleted = totalBefore - totalAfter

    console.log(
      `  ${collection.padEnd(28)}  before=${String(totalBefore).padStart(6)} ` +
      `after=${String(totalAfter).padStart(6)} ` +
      `deleted=${String(deleted).padStart(6)} ` +
      `keepers=${String(keepersAfter).padStart(4)} ` +
      `${keepersAfter === keepers ? "✓" : "✗ keeper count changed!"}`
    )

    summary.push({
      collection,
      totalBefore,
      totalAfter,
      deletable,
      keepers,
      keepersAfter,
      deleted,
      ok: keepersAfter === keepers,
    })
  }

  console.log("")
  console.log("=".repeat(72))
  const totalDeleted = summary.reduce((s, x) => s + (x.deleted ?? 0), 0)
  const totalDeletable = summary.reduce((s, x) => s + (x.deletable ?? 0), 0)
  if (DRY_RUN) {
    console.log(`DRY-RUN: would-delete total ${totalDeletable} points`)
  } else {
    console.log(`EXECUTE: deleted ${totalDeleted} points`)
    const failures = summary.filter((x) => x.ok === false)
    if (failures.length > 0) {
      console.log(`⚠️  ${failures.length} collection(s) had keeper count change — investigate`)
    }
  }
  console.log("memory_migrations: untouched (schema metadata)")
  console.log("=".repeat(72))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
