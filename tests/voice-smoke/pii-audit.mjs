#!/usr/bin/env node
/**
 * v2.1 S6 — PII-leak audit over a booking's transcript + event log.
 *
 * Done-criteria gate: 0 PII leaks across the 10 smoke calls.
 *
 * Rules (per L6 + L8):
 *   - The CONSENT BOUNDARY is the event `voice.consent_prompt_spoken`
 *     emitted by the worker after the first agent utterance. Anything
 *     the AGENT says BEFORE the consent boundary that matches a PII
 *     pattern is a violation.
 *   - The USER may say arbitrary content; we DO NOT flag user content
 *     as a leak (that is candidate-side content; the platform's job is
 *     to not re-emit it without consent).
 *   - After the consent boundary, agent utterances may include PII
 *     ONLY when (a) the booking has `piiConsentAt` ISO and (b) the
 *     utterance corresponds to a verified Level-1 dispatch path. For
 *     v2.1 smoke we treat ANY post-consent agent PII utterance as
 *     allowed (S5 owns SMS handoff dispatch).
 *
 * Detection patterns:
 *   - SSN              \b\d{3}-\d{2}-\d{4}\b
 *   - DOB              \b\d{1,2}/\d{1,2}/(?:19|20)\d{2}\b
 *   - Email            \b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b
 *   - E.164 phone      \+?[1-9]\d{6,14}\b
 *   - Dollar amount    \$\s?\d{1,3}(?:[,\d]{3})*(?:\.\d+)?
 *   - URL              https?://\S+
 *   - Full street addr \b\d+\s+\w+\s+(?:St|Ave|Blvd|Rd|Way|Dr|Ln|Ct)\b
 *
 * Usage:
 *   node pii-audit.mjs --booking <bookingId> [--mock] [--fixture path]
 *
 * Exit 0 when clean; exit 1 when leak detected.
 */
import { readFile } from "node:fs/promises"
import { parseFlag, parseBoolFlag } from "./lib/scenario-loader.mjs"
import {
  createMockFirestoreAdapter,
  createLiveFirestoreAdapter,
} from "./lib/firestore-adapter.mjs"

export const PII_PATTERNS = {
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  dob: /\b\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\b/g,
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  phone: /\+?[1-9]\d{6,14}\b/g,
  dollar: /\$\s?\d{1,3}(?:[,\d]{3})*(?:\.\d+)?/g,
  url: /https?:\/\/\S+/gi,
  street: /\b\d+\s+\w+\s+(?:St|Ave|Blvd|Rd|Way|Dr|Ln|Ct)\b/g,
}

export const CONSENT_EVENT = "voice.consent_prompt_spoken"

/**
 * Audit a transcript array (in order) given event log.
 * Returns { leaks: [{role, kind, matched, atIso, segmentIndex}], cleanCount }.
 */
export function auditTranscript({ transcript = [], events = [] }) {
  const consentEvent = events.find((e) => e.type === CONSENT_EVENT)
  const consentAt = consentEvent?.atIso ?? null

  const leaks = []
  let preConsentAgent = 0

  transcript.forEach((seg, idx) => {
    if (typeof seg?.text !== "string") return
    const role = seg.role
    // Pre-consent boundary: any agent segment without consent ISO, OR
    // any agent segment whose atIso < consentAt is pre-consent.
    const isPreConsent = !consentAt || (seg.atIso && seg.atIso < consentAt)
    if (role !== "agent") return
    if (!isPreConsent) return
    preConsentAgent += 1
    for (const [kind, regex] of Object.entries(PII_PATTERNS)) {
      const r = new RegExp(regex.source, regex.flags)
      let m
      while ((m = r.exec(seg.text)) !== null) {
        leaks.push({
          role,
          kind,
          matched: m[0],
          atIso: seg.atIso ?? null,
          segmentIndex: idx,
        })
      }
    }
  })

  return {
    leaks,
    preConsentAgentSegments: preConsentAgent,
    consentBoundaryAt: consentAt,
  }
}

/** CLI entrypoint. */
async function main(argv) {
  const bookingId = parseFlag(argv, "booking")
  const fixture = parseFlag(argv, "fixture")
  const mockMode = parseBoolFlag(argv, "mock") || !!fixture
  if (!bookingId && !fixture) {
    console.error("usage: pii-audit.mjs --booking <bookingId> [--mock | --fixture <path>]")
    process.exit(2)
  }

  let booking
  if (fixture) {
    const text = await readFile(fixture, "utf8")
    booking = JSON.parse(text)
  } else if (mockMode) {
    console.error("--mock requires --fixture <path> for transcript data")
    process.exit(2)
  } else {
    const fs = await createLiveFirestoreAdapter()
    booking = await fs.readBooking(bookingId)
    if (!booking) {
      console.error(`booking not found: ${bookingId}`)
      process.exit(2)
    }
  }

  const result = auditTranscript({
    transcript: booking.transcript ?? [],
    events: booking.events ?? [],
  })
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  process.exit(result.leaks.length === 0 ? 0 : 1)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`pii-audit.mjs failed: ${err.message}`)
    process.exit(2)
  })
}
