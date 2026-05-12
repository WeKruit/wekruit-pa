/**
 * v1.9 Phase 86 — Generic ATS inbound adapter contract.
 *
 * Schema-agnostic core. Each ATS source (Handshake, Greenhouse, Lever,
 * LinkedIn) implements `AtsAdapter` to map its raw webhook payload to the
 * canonical applicant shape consumed by `paAtsInboundWebhook`.
 *
 * Adding a new source = drop one file under `apps/functions/src/ats-adapters/`
 * + register in `apps/functions/src/ats-adapters/index.ts`.
 */

export type AtsSource = "handshake" | "greenhouse" | "lever" | "linkedin"

export interface CanonicalApplicant {
  /** External-side applicant id (stable per ATS). */
  applicantId: string
  /** External-side job id (maps to pa-jobs via pa-jobs-external-mapping). */
  jobIdExternal: string
  /** Optional internal pa-jobs id — set by lookup step, not by adapter. */
  jobIdInternal?: string
  /** Applicant legal name. */
  name: string
  /** Lowercased email (validated downstream). */
  email: string
  /** Optional E.164 phone. */
  phone?: string
  /** Optional public resume URL (PDF/DOCX). */
  resumeUrl?: string
  /** Optional base64-encoded resume body (alt to URL). */
  resumeBase64?: string
  /** Which ATS sent this. */
  source: AtsSource
  /** Free-form metadata for audit (raw payload digest, source ts, etc.). */
  meta?: Record<string, unknown>
}

export interface ParseResult {
  ok: true
  applicant: CanonicalApplicant
}

export interface ParseFailure {
  ok: false
  reason: string
}

export interface AtsAdapter {
  readonly source: AtsSource
  /**
   * Parse raw payload → CanonicalApplicant. Pure (no I/O). Returns
   * `ParseFailure` for any schema mismatch — adapter MUST NOT throw.
   */
  parse(rawPayload: unknown): ParseResult | ParseFailure
  /** Whether this adapter is implemented (vs slot stub). */
  readonly implemented: boolean
}
