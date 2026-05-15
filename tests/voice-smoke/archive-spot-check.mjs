#!/usr/bin/env node
/**
 * v2.1 S6 — GCS recording-archive spot-check.
 *
 * Verifies the egress pipeline is end-to-end live by:
 *   1. Listing objects under the `voice/` prefix in the configured GCS
 *      bucket.
 *   2. Randomly sampling N objects (default 3).
 *   3. For each, fetching metadata + asserting size > 0 + readable.
 *
 * Usage:
 *   node archive-spot-check.mjs \
 *     --bucket wekruit-voice-recordings \
 *     --count 3 \
 *     [--mock]
 *
 * Mock mode uses an in-memory bucket (used by the unit tests). Live
 * mode lazy-imports `@google-cloud/storage`.
 */
import { parseFlag, parseBoolFlag } from "./lib/scenario-loader.mjs"

/** Pure RNG-injectable random-sampling helper. */
export function sampleN(arr, n, rng = Math.random) {
  const m = Math.min(n, arr.length)
  const out = []
  const copy = arr.slice()
  for (let i = 0; i < m; i += 1) {
    const idx = Math.floor(rng() * copy.length)
    out.push(copy.splice(idx, 1)[0])
  }
  return out
}

/** Mock storage adapter — back the bucket with a Map. */
export function createMockStorageAdapter(initialFiles = []) {
  // initialFiles: [{ name, size }]
  const files = new Map(initialFiles.map((f) => [f.name, { ...f }]))
  return {
    kind: "mock",
    async listFiles(prefix) {
      const out = []
      for (const [name, meta] of files.entries()) {
        if (name.startsWith(prefix)) out.push({ name, size: meta.size ?? 0 })
      }
      return out
    },
    async getMetadata(name) {
      const f = files.get(name)
      if (!f) throw new Error(`not found: ${name}`)
      return { name, size: f.size ?? 0 }
    },
    __add(name, size = 1024) {
      files.set(name, { name, size })
    },
  }
}

/** Live GCS adapter — lazy imports @google-cloud/storage. */
export async function createLiveStorageAdapter(bucketName) {
  // eslint-disable-next-line import/no-unresolved
  const mod = await import("@google-cloud/storage")
  const { Storage } = mod
  const storage = new Storage()
  const bucket = storage.bucket(bucketName)
  return {
    kind: "live",
    async listFiles(prefix) {
      const [files] = await bucket.getFiles({ prefix })
      return files.map((f) => ({ name: f.name, size: Number(f.metadata?.size ?? 0) }))
    },
    async getMetadata(name) {
      const file = bucket.file(name)
      const [meta] = await file.getMetadata()
      return { name, size: Number(meta.size ?? 0) }
    },
  }
}

/** Run the spot-check. Returns { samples, ok, failures }. */
export async function runSpotCheck({ storage, prefix = "voice/", count = 3, rng = Math.random }) {
  const files = await storage.listFiles(prefix)
  if (files.length === 0) {
    return { samples: [], ok: false, reason: "no_files", failures: [] }
  }
  const samples = sampleN(files, count, rng)
  const failures = []
  for (const f of samples) {
    try {
      const meta = await storage.getMetadata(f.name)
      if (!meta.size || meta.size <= 0) {
        failures.push({ name: f.name, reason: "zero_size" })
      }
    } catch (err) {
      failures.push({ name: f.name, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { samples, ok: failures.length === 0, failures }
}

async function main(argv) {
  const bucketName = parseFlag(argv, "bucket") ?? process.env.WEKRUIT_VOICE_RECORDINGS_BUCKET
  const count = Number.parseInt(parseFlag(argv, "count") ?? "3", 10)
  const mockMode = parseBoolFlag(argv, "mock")

  if (!bucketName) {
    console.error("usage: archive-spot-check.mjs --bucket <name> [--count 3] [--mock]")
    process.exit(2)
  }

  let storage
  if (mockMode) {
    // For CLI ergonomics, mock CLI mode pre-seeds 5 fake files so the
    // smoke driver can dry-run end-to-end without the GCS SDK.
    storage = createMockStorageAdapter([
      { name: "voice/b1/r1-1000.mp4", size: 2048 },
      { name: "voice/b2/r2-1001.mp4", size: 4096 },
      { name: "voice/b3/r3-1002.mp4", size: 1024 },
      { name: "voice/b4/r4-1003.mp4", size: 8192 },
      { name: "voice/b5/r5-1004.mp4", size: 512 },
    ])
  } else {
    storage = await createLiveStorageAdapter(bucketName)
  }

  const result = await runSpotCheck({ storage, prefix: "voice/", count })
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  process.exit(result.ok ? 0 : 1)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`archive-spot-check.mjs failed: ${err.message}`)
    process.exit(2)
  })
}
