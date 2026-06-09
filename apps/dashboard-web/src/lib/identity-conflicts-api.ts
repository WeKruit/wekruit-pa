import { httpsCallable } from "firebase/functions"

export const IDENTITY_CONFLICTS_ROUTE = "/admin/identity-conflicts"
export const IDENTITY_CONFLICTS_CALLABLE = "paAdminIdentityConflictsResolve"
// Callable schema caps conflictIds at 200 per call; larger selections are chunked.
const RESOLVE_BATCH_LIMIT = 200

export type IdentityConflictResolveStatus = "resolved" | "dismissed"

export interface IdentityConflictsResolveInput {
  action: "resolve"
  conflictIds: string[]
  status: IdentityConflictResolveStatus
  note?: string
}

export interface IdentityConflictsCountsInput {
  action: "counts"
}

export interface IdentityConflictsResolveResult {
  ok: true
  action: "resolve"
  status: IdentityConflictResolveStatus
  updated: number
  skipped: number
}

export interface IdentityConflictsCounts {
  ok: true
  action: "counts"
  total: number
  byStatus: Record<string, number>
  byHandleKind: Record<string, number>
}

export async function resolveIdentityConflicts(
  conflictIds: string[],
  status: IdentityConflictResolveStatus,
  note?: string,
): Promise<IdentityConflictsResolveResult> {
  const { functions } = await import("./firebase.js")
  const fn = httpsCallable<IdentityConflictsResolveInput, Partial<IdentityConflictsResolveResult>>(
    functions(),
    IDENTITY_CONFLICTS_CALLABLE,
  )
  const trimmedNote = note?.trim()
  let updated = 0
  let skipped = 0
  for (let start = 0; start < conflictIds.length; start += RESOLVE_BATCH_LIMIT) {
    const result = await fn({
      action: "resolve",
      conflictIds: conflictIds.slice(start, start + RESOLVE_BATCH_LIMIT),
      status,
      ...(trimmedNote ? { note: trimmedNote } : {}),
    })
    updated += Number(result.data?.updated ?? 0)
    skipped += Number(result.data?.skipped ?? 0)
  }
  return {
    ok: true,
    action: "resolve",
    status,
    updated,
    skipped,
  }
}

export async function getIdentityConflictCounts(): Promise<IdentityConflictsCounts> {
  const { functions } = await import("./firebase.js")
  const fn = httpsCallable<IdentityConflictsCountsInput, Partial<IdentityConflictsCounts>>(
    functions(),
    IDENTITY_CONFLICTS_CALLABLE,
  )
  const result = await fn({ action: "counts" })
  return {
    ok: true,
    action: "counts",
    total: Number(result.data?.total ?? 0),
    byStatus: normalizeCountRecord(result.data?.byStatus),
    byHandleKind: normalizeCountRecord(result.data?.byHandleKind),
  }
}

function normalizeCountRecord(record: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(record ?? {})) {
    out[key] = Number.isFinite(Number(value)) ? Number(value) : 0
  }
  return out
}
