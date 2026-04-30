/**
 * Phase 36 — A/B arm router (sticky bucket assignment).
 *
 * Maps a `userId` → `InjectorArm` deterministically, with optional env
 * override (`PA_IMPERFECTION_ARM=off|low|high`) for tests + Adam manual
 * control.
 *
 * Hash: djb2-style 32-bit, pure function, identical across deploys. We
 * mod 100 → bucket. Default split: 33/33/34 (off / low / high) — fits
 * a 3-arm A/B at equal allocation. Adam can override per-deploy via
 * `opts.ratios`.
 *
 * **Note on terminology**: the ARM is the user's A/B group. The FIRING
 * RATE within an arm is enforced by `injectImperfection` (off=0%,
 * low=15%, high=30%). This module only assigns the arm.
 *
 * Env override semantics (D-36-2):
 * - `PA_IMPERFECTION_ARM_OFF=true` → kill switch; always returns "off"
 * - `PA_IMPERFECTION_ARM=off|low|high` → override hash assignment
 * - both unset → hash + bucket lookup
 *
 * Latency: < 0.05ms per call (pure JS).
 */
import type { ArmBucketRatios, InjectorArm, ResolveArmOpts } from "./types.js"

const DEFAULT_RATIOS: ArmBucketRatios = { off: 33, low: 33, high: 34 }
const ENV_OVERRIDE_KEY = "PA_IMPERFECTION_ARM"
const ENV_KILLSWITCH_KEY = "PA_IMPERFECTION_ARM_OFF"

/**
 * djb2 hash → 32-bit unsigned. Pure, deterministic across runtimes.
 * Identical output across Node versions.
 *
 * djb2's low bits are slightly biased on short inputs; we mix high bits
 * down via xor-shift before returning. This keeps `% 100` uniform within
 * stat noise on short ids like `user-1`, `user-2`, ...
 */
export function djb2Hash(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    // (hash * 33) ^ char
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
  }
  // Avalanche — fold high bits into low to flatten % N distribution.
  // (xorshift32-style finalizer)
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

function readEnvOverride(): InjectorArm | null {
  if (process.env[ENV_KILLSWITCH_KEY]?.trim().toLowerCase() === "true") {
    return "off"
  }
  const raw = process.env[ENV_OVERRIDE_KEY]?.trim().toLowerCase()
  if (!raw) return null
  if (raw === "off" || raw === "low" || raw === "high") return raw
  return null
}

function validateRatios(r: ArmBucketRatios): void {
  const sum = r.off + r.low + r.high
  if (sum !== 100) {
    throw new Error(
      `arm-router: ratios must sum to 100, got ${sum} (off=${r.off}, low=${r.low}, high=${r.high})`
    )
  }
  if (r.off < 0 || r.low < 0 || r.high < 0) {
    throw new Error(`arm-router: negative ratio: ${JSON.stringify(r)}`)
  }
}

/**
 * Resolve a user's A/B arm.
 *
 * Order:
 *  1. If env kill switch set → "off" (unless `ignoreEnv: true`)
 *  2. If env override set → that arm (unless `ignoreEnv: true`)
 *  3. Hash userId → bucket → arm via ratios
 *
 * Empty userId → defaults to "off" (no sticky bucket without an id).
 * Tests can pass a synthetic id like `"test-1"`, `"test-2"`, etc.
 *
 * @param userId  The stable user identifier (e.g. E.164 phone or uid)
 * @param opts    Optional ratio override and env-ignore for tests
 * @returns       Assigned arm
 */
export function resolveArm(userId: string, opts: ResolveArmOpts = {}): InjectorArm {
  if (!opts.ignoreEnv) {
    const env = readEnvOverride()
    if (env) return env
  }
  if (!userId || userId.length === 0) return "off"

  const ratios = opts.ratios ?? DEFAULT_RATIOS
  validateRatios(ratios)

  const bucket = djb2Hash(userId) % 100
  if (bucket < ratios.off) return "off"
  if (bucket < ratios.off + ratios.low) return "low"
  return "high"
}

/**
 * The within-arm FIRING RATE for the imperfection injector. Used by
 * `injectImperfection` to decide whether to inject this turn.
 *
 *   off:  0%
 *   low:  15%
 *   high: 30%
 */
export function firingRateForArm(arm: InjectorArm): number {
  switch (arm) {
    case "off":
      return 0
    case "low":
      return 0.15
    case "high":
      return 0.3
  }
}
