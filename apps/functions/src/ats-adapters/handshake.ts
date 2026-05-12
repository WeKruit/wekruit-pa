/**
 * v1.9 Phase 86 — Handshake adapter.
 *
 * Handshake webhook payload shape (representative — confirm with their
 * docs before production wiring):
 *
 * {
 *   "event": "application.submitted",
 *   "data": {
 *     "applicant_id": "hs_app_12345",
 *     "job_id": "hs_job_67890",
 *     "candidate": {
 *       "first_name": "Alex",
 *       "last_name": "Lee",
 *       "email": "alex@school.edu",
 *       "phone": "+14155550199"
 *     },
 *     "resume_url": "https://handshake.app/r/abc.pdf"
 *   },
 *   "ts": "2026-05-12T10:00:00Z"
 * }
 *
 * Mapping is permissive — missing optional fields (phone / resume) are OK;
 * missing core fields (applicant_id / job_id / email) reject.
 */

import type { AtsAdapter, ParseResult, ParseFailure } from "./types.js"

interface RawHandshake {
  event?: string
  data?: {
    applicant_id?: string
    job_id?: string
    candidate?: {
      first_name?: string
      last_name?: string
      email?: string
      phone?: string
    }
    resume_url?: string
    resume_base64?: string
  }
  ts?: string
}

export const handshakeAdapter: AtsAdapter = {
  source: "handshake",
  implemented: true,
  parse(rawPayload: unknown): ParseResult | ParseFailure {
    if (typeof rawPayload !== "object" || rawPayload === null) {
      return { ok: false, reason: "payload_not_object" }
    }
    const p = rawPayload as RawHandshake
    if (p.event && p.event !== "application.submitted") {
      return { ok: false, reason: `unsupported_event_${p.event}` }
    }
    const data = p.data
    if (!data) return { ok: false, reason: "missing_data" }
    const applicantId = data.applicant_id?.trim()
    const jobId = data.job_id?.trim()
    const email = data.candidate?.email?.trim().toLowerCase()
    if (!applicantId) return { ok: false, reason: "missing_applicant_id" }
    if (!jobId) return { ok: false, reason: "missing_job_id" }
    if (!email) return { ok: false, reason: "missing_email" }
    const first = data.candidate?.first_name?.trim() ?? ""
    const last = data.candidate?.last_name?.trim() ?? ""
    const name = [first, last].filter(Boolean).join(" ").trim() || email.split("@")[0]
    return {
      ok: true,
      applicant: {
        applicantId,
        jobIdExternal: jobId,
        name,
        email,
        phone: data.candidate?.phone?.trim() || undefined,
        resumeUrl: data.resume_url?.trim() || undefined,
        resumeBase64: data.resume_base64 || undefined,
        source: "handshake",
        meta: {
          event: p.event,
          ts: p.ts,
        },
      },
    }
  },
}
