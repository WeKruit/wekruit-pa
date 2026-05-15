import {
  ExternalCandidateRecordSchema,
  type ExternalCandidateRecord,
} from "@pa/core-types"

export function normalizeExternalCandidateRecordDoc(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
  const doc = { ...(raw as Record<string, unknown>) }
  if (doc.resolvedUserId === null) delete doc.resolvedUserId
  if (doc.resolutionConflictId === null) delete doc.resolutionConflictId
  if (doc.reviewReasons === null) doc.reviewReasons = []
  return doc
}

export function parseExternalCandidateRecordDoc(raw: unknown): ExternalCandidateRecord | null {
  const parsed = ExternalCandidateRecordSchema.safeParse(normalizeExternalCandidateRecordDoc(raw))
  return parsed.success ? parsed.data : null
}
