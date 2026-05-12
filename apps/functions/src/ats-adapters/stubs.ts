/**
 * v1.9 Phase 86 — Slot stubs for Greenhouse / Lever / LinkedIn.
 *
 * Reserve adapter slots so the registry has full type coverage. Each returns
 * `not_implemented` until a future milestone wires real schema.
 */

import type { AtsAdapter, AtsSource, ParseFailure } from "./types.js"

function stub(source: AtsSource): AtsAdapter {
  return {
    source,
    implemented: false,
    parse(): ParseFailure {
      return { ok: false, reason: `${source}_adapter_not_implemented` }
    },
  }
}

export const greenhouseAdapter: AtsAdapter = stub("greenhouse")
export const leverAdapter: AtsAdapter = stub("lever")
export const linkedinAdapter: AtsAdapter = stub("linkedin")
