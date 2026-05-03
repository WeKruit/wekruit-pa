#!/usr/bin/env node
/**
 * iter30 WS1 GO/NO-GO — Mem0 metadata round-trip via Qdrant direct read.
 *
 * What this proves:
 *   1. `mem0Add(config, msgs, userId, { metadata, agentId, infer:false })`
 *      flows the iter30 metadata fields through the Mem0 OSS SDK.
 *   2. The Mem0 Qdrant adapter inserts that metadata as the point payload.
 *   3. Reading the point back via the underlying Qdrant HTTP API surfaces
 *      every metadata key we wrote — no silent SDK swallow.
 *
 * Why direct Qdrant read (not `Memory.search()`):
 *   - `Memory.search()` strips payload to `{ memory, score }` and runs a
 *     similarity threshold. We need the raw payload, post-write, no LLM
 *     extractor in the loop. Hitting `/collections/{name}/points/scroll`
 *     directly via `FetchQdrantClient` skips both layers.
 *
 * Why `infer: false`:
 *   - With `infer: true` (SDK default), Mem0 runs an LLM-based fact extractor
 *     that may discard the message entirely (Adam's free-tier Qwen-7B may
 *     return zero facts), leading to a false-negative round-trip. `infer:
 *     false` stores the message verbatim with the supplied metadata, which
 *     is exactly what we need to assert the metadata pipeline works.
 *
 * Required env: QDRANT_URL, QDRANT_API_KEY, SILICONFLOW_API_KEY (the SDK
 * still constructs an embedder + LLM lazily; only the embedder is invoked
 * when `infer: false`, so the LLM never fires).
 *
 * Optional env: MEM0_QDRANT_COLLECTION (defaults to `pa-memory`).
 *
 * Cleanup: the script deletes its own test point at the end so we never
 * pollute production Qdrant. If it fails before cleanup, run
 *   curl -XPOST $QDRANT_URL/collections/pa-memory/points/delete?wait=true \
 *     -H "api-key: $QDRANT_API_KEY" -d '{"filter":{"must":[{"key":"source","match":{"value":"iter30-verify"}}]}}'
 */
import { mem0Add, _resetMem0Client } from "../dist/mem0.js"
import { FetchQdrantClient } from "../dist/qdrant-fetch.js"

const QDRANT_URL = (process.env.QDRANT_URL ?? "").trim()
const QDRANT_API_KEY = (process.env.QDRANT_API_KEY ?? "").trim()
const SILICONFLOW_API_KEY = (process.env.SILICONFLOW_API_KEY ?? "").trim()
const COLLECTION = (process.env.MEM0_QDRANT_COLLECTION ?? "pa-memory").trim() || "pa-memory"

if (!QDRANT_URL || !QDRANT_API_KEY || !SILICONFLOW_API_KEY) {
  console.error("FAIL — missing env: QDRANT_URL / QDRANT_API_KEY / SILICONFLOW_API_KEY")
  process.exit(2)
}

const config = {
  apiKey: SILICONFLOW_API_KEY,
  qdrantUrl: QDRANT_URL,
  qdrantApiKey: QDRANT_API_KEY,
  qdrantCollection: COLLECTION,
}

const TEST_RUN = Date.now()
const TEST_USER_ID = `iter30-verify-${TEST_RUN}`
const METADATA = {
  intentTag: "preference",
  source: "iter30-verify",
  testRun: TEST_RUN,
}

function fmt(o) {
  return JSON.stringify(o, null, 2)
}

async function cleanup(qdrant) {
  try {
    await qdrant.delete(COLLECTION, {
      filter: {
        must: [
          { key: "source", match: { value: "iter30-verify" } },
          { key: "user_id", match: { value: TEST_USER_ID } },
        ],
      },
    })
  } catch (e) {
    console.error("[cleanup] WARN — could not delete test point:", e?.message ?? e)
  }
}

async function main() {
  const qdrant = new FetchQdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY })

  // 1. Pre-flight: confirm collection exists. If not, mem0's auto-init
  //    creates it on first add, so this is informational only.
  let collectionInfoOk = true
  try {
    await qdrant.getCollection(COLLECTION)
    console.log(`[pre] collection "${COLLECTION}" exists`)
  } catch (e) {
    collectionInfoOk = false
    console.log(`[pre] collection "${COLLECTION}" not found — mem0 will create on add`)
  }

  // 2. Write via the new metadata-aware mem0Add. infer:false stores the
  //    message verbatim with our metadata as the Qdrant payload.
  console.log(`[write] mem0Add userId=${TEST_USER_ID} metadata=${fmt(METADATA)}`)
  _resetMem0Client()
  let writeStart = Date.now()
  try {
    await mem0Add(
      config,
      [
        {
          role: "user",
          content: `iter30 round-trip probe ${TEST_RUN} — please ignore (test only).`,
        },
      ],
      TEST_USER_ID,
      {
        metadata: METADATA,
        agentId: "iter30-verify-agent",
        infer: false,
      }
    )
    console.log(`[write] mem0Add ok in ${Date.now() - writeStart}ms`)
  } catch (e) {
    console.error("FAIL — mem0Add threw:", e)
    await cleanup(qdrant)
    process.exit(1)
  }

  // 3. Direct Qdrant scroll read on the underlying collection. Filter by
  //    user_id (Mem0 stamps it into payload) AND our `source` marker so we
  //    only see this test's points.
  let points = []
  let scrollErr = null
  try {
    const r = await qdrant.scroll(COLLECTION, {
      limit: 10,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          { key: "user_id", match: { value: TEST_USER_ID } },
          { key: "source", match: { value: "iter30-verify" } },
        ],
      },
    })
    points = r.points ?? []
  } catch (e) {
    scrollErr = e
  }
  console.log(`[read] scroll returned ${points.length} point(s)`)

  if (scrollErr || points.length === 0) {
    console.error("FAIL — no points found post-write. Possible causes:")
    console.error("  (a) Mem0 SDK swallowed metadata → no `source` field in payload")
    console.error("  (b) Mem0 wrote to a different collection")
    console.error("  (c) Qdrant write was eventually-consistent and we read too fast")
    if (scrollErr) console.error("  scroll error:", scrollErr?.message ?? scrollErr)
    // Try a wider scroll to inspect what DID land
    try {
      const wide = await qdrant.scroll(COLLECTION, {
        limit: 5,
        with_payload: true,
        filter: { must: [{ key: "user_id", match: { value: TEST_USER_ID } }] },
      })
      console.error(
        "[debug] scroll-by-user_id alone returned",
        wide.points.length,
        "points; payloads:",
        fmt(wide.points.map((p) => p.payload))
      )
    } catch (e2) {
      console.error("[debug] scroll-by-user_id failed:", e2?.message ?? e2)
    }
    await cleanup(qdrant)
    process.exit(1)
  }

  // 4. Assert each metadata key round-tripped.
  const point = points[0]
  const payload = point.payload ?? {}
  console.log("[read] full payload:")
  console.log(fmt(payload))

  const failures = []
  if (payload.intentTag !== METADATA.intentTag) {
    failures.push(`intentTag: expected="${METADATA.intentTag}" got="${payload.intentTag}"`)
  }
  if (payload.source !== METADATA.source) {
    failures.push(`source: expected="${METADATA.source}" got="${payload.source}"`)
  }
  if (payload.testRun !== METADATA.testRun) {
    failures.push(`testRun: expected=${METADATA.testRun} got=${payload.testRun}`)
  }
  if (payload.user_id !== TEST_USER_ID) {
    failures.push(`user_id (SDK-stamped): expected="${TEST_USER_ID}" got="${payload.user_id}"`)
  }
  if (payload.agent_id !== "iter30-verify-agent") {
    failures.push(`agent_id (SDK-stamped): expected="iter30-verify-agent" got="${payload.agent_id}"`)
  }

  if (failures.length > 0) {
    console.error("FAIL — metadata round-trip mismatches:")
    for (const f of failures) console.error("  -", f)
    await cleanup(qdrant)
    process.exit(1)
  }

  console.log("\nPASS — metadata round-trip clean.")
  console.log("  collectionExisted:", collectionInfoOk)
  console.log("  pointId:", point.id)
  console.log("  user_id stamp:", payload.user_id)
  console.log("  agent_id stamp:", payload.agent_id)
  console.log("  intentTag:", payload.intentTag)
  console.log("  source:", payload.source)
  console.log("  testRun:", payload.testRun)

  await cleanup(qdrant)
  console.log("[cleanup] test point deleted")
}

main().catch(async (e) => {
  console.error("FAIL — unexpected exception:", e)
  process.exit(1)
})
