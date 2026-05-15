/**
 * v2.1 S5 — DNC (Do-Not-Call) check.
 *
 * Source of truth: Firestore collection `voice-dnc/{phoneE164}`. Document
 * presence = blocked. Payload shape is opaque to this check (admin tooling
 * may store `addedBy`, `reason`, etc. — we don't read them).
 *
 * Why doc-id keyed: O(1) point read, no scan, no index. The doc id IS the
 * normalized E.164 phone, so admins can drop seed CSVs with column 1 = phone
 * straight into Firestore import.
 *
 * NEVER writes Firestore. Read-only.
 */

import type { Firestore } from "firebase-admin/firestore"
import type { DncResult } from "./types.js"

/** Trim + canonicalize phone for safe Firestore doc-id usage. */
function normalizePhone(phoneE164: string): string {
  // E.164 already prohibits whitespace, but defensive trim catches operator
  // paste-errors when seeding DNC manually.
  return phoneE164.trim()
}

export interface CheckDncDeps {
  /** Injected Firestore — production passes admin SDK, tests pass `MockFirestore`. */
  fs: Firestore
}

/**
 * Returns `{ blocked: true, reason: "dnc_listed" }` iff `voice-dnc/{phoneE164}`
 * exists. Otherwise `{ blocked: false }`. Never throws on missing doc — only
 * on Firestore connectivity errors, which propagate to the gate orchestrator.
 */
export async function checkDnc(
  phoneE164: string,
  deps: CheckDncDeps,
): Promise<DncResult> {
  const normalized = normalizePhone(phoneE164)
  if (normalized.length === 0) {
    return { blocked: false, phoneE164: normalized }
  }
  const snap = await deps.fs.collection("voice-dnc").doc(normalized).get()
  if (snap.exists) {
    return { blocked: true, reason: "dnc_listed", phoneE164: normalized }
  }
  return { blocked: false, phoneE164: normalized }
}
