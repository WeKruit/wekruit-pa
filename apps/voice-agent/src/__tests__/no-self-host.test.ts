/**
 * Lock L12: LiveKit Cloud managed agent hosting ONLY.
 *
 * Forbidden under `apps/voice-agent/`:
 *   - Dockerfile
 *   - k8s/ directory
 *   - docker-compose.yml / docker-compose.yaml
 *   - kustomization.yaml
 *
 * LiveKit Cloud builds the container from `livekit.toml`. If we ever add
 * any of the above, the deploy story drifts from L12. This test enforces
 * the lock on every commit.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(here, "..", "..")

const FORBIDDEN = [
  "Dockerfile",
  "Dockerfile.prod",
  "docker-compose.yml",
  "docker-compose.yaml",
  "k8s",
  "kustomization.yaml",
  ".dockerignore", // optional but unwanted noise
]

test("L12: no self-host infrastructure under apps/voice-agent/", () => {
  const offenders: string[] = []
  for (const name of FORBIDDEN) {
    const full = path.join(PKG_ROOT, name)
    if (existsSync(full)) offenders.push(name)
  }
  assert.deepEqual(
    offenders,
    [],
    `L12 violation — found self-host artifacts: ${offenders.join(", ")}`
  )
})

test("L12: livekit.toml exists", () => {
  assert.equal(
    existsSync(path.join(PKG_ROOT, "livekit.toml")),
    true,
    "livekit.toml is required for LiveKit Cloud managed agent hosting (L12)"
  )
})
