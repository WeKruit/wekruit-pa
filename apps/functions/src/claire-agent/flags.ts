/**
 * flags.ts — the `paThinClaireEnabled` cutover flag.
 *
 * Same mechanism as the other agentic canary flags (per-user, allowlist-driven,
 * `pa-feature-flags` collection, `@pa/pa-persistence` getFlag, env override
 * `PA_THIN_CLAIRE_ENABLED=1`). Default OFF — legacy path stays until thin is
 * green for the 424 canary cohort.
 */
import type { Firestore } from "firebase-admin/firestore"
import { getFlag } from "@pa/pa-persistence"

export const THIN_CLAIRE_FLAG_KEY = "paThinClaireEnabled"

/** 424 canary uids (allowlist seeded in admin-bootstrap, same cohort as the agentic flags). */
export const THIN_CLAIRE_CANARY_UIDS = [
  "8fEwIduUrzxZsblHHsNz",
  "LF8blURXyFBaeF7bhupu",
] as const

/** Seed descriptor for admin-bootstrap.ts (perUser, default false, canary allowlist). */
export const THIN_CLAIRE_FLAG_SEED = {
  key: THIN_CLAIRE_FLAG_KEY,
  value: false,
  type: "bool" as const,
  scope: "perUser" as const,
  allowlist: [...THIN_CLAIRE_CANARY_UIDS],
  blocklist: [] as string[],
}

/** Is the thin Claire path enabled for this user? Default OFF. */
export async function isThinClaireEnabled(db: Firestore, userId: string): Promise<boolean> {
  const value = await getFlag(db, THIN_CLAIRE_FLAG_KEY, { userId }, false)
  return value === true
}

export const THIN_PRESCREEN_FLAG_KEY = "paThinPrescreenEnabled"

/** Same canary cohort as thin Claire (allowlist-gated, default OFF). */
export const THIN_PRESCREEN_CANARY_UIDS = ["8fEwIduUrzxZsblHHsNz"] as const

/** Seed descriptor for admin-bootstrap.ts (perUser, default false, canary allowlist). */
export const THIN_PRESCREEN_FLAG_SEED = {
  key: THIN_PRESCREEN_FLAG_KEY,
  value: false,
  type: "bool" as const,
  scope: "perUser" as const,
  allowlist: [...THIN_PRESCREEN_CANARY_UIDS],
  blocklist: [] as string[],
}

/**
 * Is the thin prescreen engine enabled for this user? Default OFF → defer to legacy prescreen.
 * `env: process.env` is passed so the env override `paThinPrescreenEnabled=1` short-circuits true in
 * evals (isEnvOverride reads env[key] verbatim — the flag key, NOT an UPPER_SNAKE transform).
 */
export async function isThinPrescreenEnabled(db: Firestore, userId: string): Promise<boolean> {
  const value = await getFlag(db, THIN_PRESCREEN_FLAG_KEY, { userId, env: process.env }, false)
  return value === true
}
