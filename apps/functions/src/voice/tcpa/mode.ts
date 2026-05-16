/**
 * v2.1 S5 — TCPA gate mode resolver.
 *
 * Lock L4: TCPA is a **prod** gate. Default (unset) = `observed` so
 * dev/staging/CI deploys don't accidentally block dial. Flip
 * `PA_TCPA_GATE_ENFORCED=true` only when production rollout starts.
 *
 * Accepted truthy values: `"true"`, `"1"`, `"yes"`, `"on"` (case-insensitive,
 * whitespace-trimmed). Anything else, including unset, resolves to
 * `observed`.
 */

import type { GateMode } from "./types.js"

const TRUTHY = new Set(["true", "1", "yes", "on"])

export interface ReadGateModeOpts {
  /** Test seam — read from a passed-in env map instead of `process.env`. */
  env?: Record<string, string | undefined>
}

export function readGateMode(opts: ReadGateModeOpts = {}): GateMode {
  const env = opts.env ?? (process.env as Record<string, string | undefined>)
  const raw = env.PA_TCPA_GATE_ENFORCED
  if (typeof raw !== "string") return "observed"
  if (TRUTHY.has(raw.trim().toLowerCase())) return "blocking"
  return "observed"
}
