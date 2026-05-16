/**
 * v2.1 S1B — `loadPrescreenConfigForVoice(jobId)`.
 *
 * Read-only loader for `pa-jobs/{jobId}.prescreenConfig`. Uses canonical
 * `safeParsePrescreenConfig` from `@pa/pa-orchestrator` — same path
 * `prescreen-session-start.ts` already uses for iMessage. No new
 * validation. No alternate schema.
 *
 * Contract:
 *  - `pa-jobs/{jobId}` doc absent OR `prescreenConfig` field absent → throw
 *    `NotFoundError("prescreen-config", jobId)`. The voice bridge will play
 *    the same "still being prepared" notice path that iMessage uses on
 *    `config_missing` (see `prescreen-session-start.ts:82-97`).
 *  - `prescreenConfig` present but Zod validation fails → throw
 *    `NotFoundError("prescreen-config", jobId)`. We do not surface a partial
 *    config because `PreScreenPipeline.runTurn` strictly relies on the
 *    canonical shape — running a half-validated config would corrupt state.
 *  - Happy path → return `VoicePrescreenConfig`. `missingFields` enumerates
 *    *optional* canonical fields that were absent (e.g. `level1Reveal`,
 *    `company`). Required fields' presence is guaranteed by Zod.
 *  - NEVER writes Firestore.
 */

import type { Firestore } from "firebase-admin/firestore"
import { safeParsePrescreenConfig } from "@pa/pa-orchestrator"
import { NotFoundError, type VoicePrescreenConfig } from "./types.js"

/**
 * Load + Zod-validate a job's prescreen config for the voice bridge.
 *
 * @throws {NotFoundError} when the job doc is absent, `prescreenConfig` is
 *   absent, or the embedded config fails canonical Zod validation.
 */
export async function loadPrescreenConfigForVoice(
  db: Firestore,
  jobId: string
): Promise<VoicePrescreenConfig> {
  if (typeof jobId !== "string" || jobId.trim().length === 0) {
    throw new TypeError(
      "loadPrescreenConfigForVoice: jobId must be a non-empty string"
    )
  }
  const snap = await db.collection("pa-jobs").doc(jobId).get()
  if (!snap.exists) {
    throw new NotFoundError("prescreen-config", jobId)
  }
  const data = (snap.data() ?? {}) as Record<string, unknown>
  const rawCfg = data.prescreenConfig
  if (rawCfg === undefined || rawCfg === null) {
    throw new NotFoundError("prescreen-config", jobId)
  }
  const parsed = safeParsePrescreenConfig(rawCfg)
  if (!parsed.ok) {
    // Caller (S2) treats this the same as a missing config: surface the
    // generic "still being prepared" notice. We keep the contract narrow on
    // purpose — voice cannot run an invalid pipeline config.
    throw new NotFoundError("prescreen-config", jobId)
  }
  const cfg = parsed.config

  const missing: string[] = []
  if (cfg.company === undefined) missing.push("company")
  if (cfg.level1Reveal === undefined) missing.push("level1Reveal")

  const out: VoicePrescreenConfig = {
    jobId,
    version: cfg.version,
    jobTitle: cfg.jobTitle,
    threshold: cfg.threshold,
    confidenceThreshold: cfg.confidenceThreshold,
    maxClarifyRounds: cfg.maxClarifyRounds,
    voiceMode: cfg.voiceMode,
    questions: cfg.questions,
    parsedFromZod: true,
    missingFields: missing,
  }
  if (cfg.company !== undefined) out.company = cfg.company
  if (cfg.level1Reveal !== undefined) out.level1Reveal = cfg.level1Reveal

  return out
}
