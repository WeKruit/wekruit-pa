/**
 * v2.1 S5 — Voice-recording consent check.
 *
 * Source: `pa-users/{userId}.consent.voiceRecording` boolean +
 *         `pa-users/{userId}.consent.voiceRecordingConsentAt` ISO timestamp.
 *
 * Three block paths:
 *   - `user_not_found`    — `pa-users/{uid}` doc absent
 *   - `consent_missing`   — doc exists but no `consent` map / no `voiceRecording` field
 *   - `consent_denied`    — `consent.voiceRecording === false`
 *
 * NOTE: This is **prior consent** verification, not the at-call-start
 * recording disclosure (that's L8, handled by `consent-prompt.ts` in the
 * voice-agent worker). The L8 disclosure plays AFTER the gate allows the
 * dial; this check ensures we have legal basis to dial in the first place.
 *
 * NEVER writes Firestore. Read-only.
 */

import type { Firestore } from "firebase-admin/firestore"
import type { ConsentResult } from "./types.js"

export interface CheckConsentDeps {
  fs: Firestore
}

interface PaUserConsentDoc {
  consent?: {
    voiceRecording?: boolean
    voiceRecordingConsentAt?: string
  }
}

export async function checkConsent(
  paUserId: string,
  deps: CheckConsentDeps,
): Promise<ConsentResult> {
  const uid = paUserId.trim()
  if (uid.length === 0) {
    return { blocked: true, reason: "user_not_found", consentedAt: "" }
  }
  const snap = await deps.fs.collection("pa-users").doc(uid).get()
  if (!snap.exists) {
    return { blocked: true, reason: "user_not_found", consentedAt: "" }
  }
  const data = (snap.data() ?? {}) as PaUserConsentDoc
  const consent = data.consent
  if (!consent || typeof consent.voiceRecording !== "boolean") {
    return { blocked: true, reason: "consent_missing", consentedAt: "" }
  }
  if (consent.voiceRecording === false) {
    return {
      blocked: true,
      reason: "consent_denied",
      consentedAt: typeof consent.voiceRecordingConsentAt === "string"
        ? consent.voiceRecordingConsentAt
        : "",
    }
  }
  return {
    blocked: false,
    consentedAt: typeof consent.voiceRecordingConsentAt === "string"
      ? consent.voiceRecordingConsentAt
      : "",
  }
}
