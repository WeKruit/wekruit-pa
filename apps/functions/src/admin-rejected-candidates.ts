/**
 * `paAdminRejectedCandidatesSnapshot` — admin browse of rejected candidates by
 * their GLOBAL best-wins tier (pa-users.globalCandidateTier), so a tier_1
 * reject (strong, wrong role) can be re-reviewed for new roles.
 *
 * Reads only pa-users (single ordered scan on globalCandidateTier.updatedAt —
 * docs without the field are rejected-tier-free and excluded), filters tier /
 * reusable in-memory. Per-role rejection history is loaded lazily by the drawer
 * via paAdminCandidateTierHistory. Auth via the shared admin gate.
 */
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { defineSecret } from "firebase-functions/params"
import { HttpsError, onCall } from "firebase-functions/v2/https"
import { z } from "zod"
import {
  PA_COLLECTIONS,
  CandidateTierSchema,
  isSyntheticTestProfile,
  type CandidateTier,
  type CandidateListUserDoc,
  type GlobalCandidateTier,
} from "@pa/core-types"
import { authorizeAdminCallable } from "./promote-sandbox-tag.js"

const PA_ADMIN_TOKEN = defineSecret("PA_ADMIN_TOKEN")
const SCAN_CAP = 4_000

export const AdminRejectedCandidatesInputSchema = z.object({
  tier: CandidateTierSchema.optional(),
  reusableOnly: z.boolean().optional().default(false),
  includeTest: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(1_000).optional().default(200),
  adminToken: z.string().optional(),
})
export type AdminRejectedCandidatesInput = z.infer<typeof AdminRejectedCandidatesInputSchema>

export interface RejectedCandidateRow {
  candidateId: string
  displayName?: string
  tier: CandidateTier
  source: GlobalCandidateTier["source"]
  reusable: boolean
  rejectionCount: number
  updatedAt: string
  lastJobId?: string
  lastReason?: string
  humanConfirmed: boolean
}

export interface AdminRejectedCandidatesResult {
  rows: RejectedCandidateRow[]
  counts: { tier_1: number; tier_2: number; tier_3: number; reusable: number; total: number }
  truncated: boolean
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

export async function runAdminRejectedCandidates(
  input: AdminRejectedCandidatesInput,
  deps: { db: Firestore },
): Promise<AdminRejectedCandidatesResult> {
  const snap = await deps.db
    .collection(PA_COLLECTIONS.users)
    .orderBy("globalCandidateTier.updatedAt", "desc")
    .limit(SCAN_CAP)
    .get()

  // Count the full tiered population (pre tier/reusable filter) for the chips.
  const counts = { tier_1: 0, tier_2: 0, tier_3: 0, reusable: 0, total: 0 }
  const rows: RejectedCandidateRow[] = []

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>
    const gt = data.globalCandidateTier as GlobalCandidateTier | undefined
    if (!gt || typeof gt !== "object" || !gt.tier) continue
    if (!input.includeTest && isSyntheticTestProfile({ ...data, id: doc.id } as unknown as CandidateListUserDoc)) continue

    counts.total += 1
    counts[gt.tier] += 1
    if (gt.reusable) counts.reusable += 1

    if (input.tier && gt.tier !== input.tier) continue
    if (input.reusableOnly && !gt.reusable) continue
    if (rows.length >= input.limit) continue

    rows.push({
      candidateId: doc.id,
      displayName: asString(data.displayName) ?? asString(data.latestRecruiterCurrentRole),
      tier: gt.tier,
      source: gt.source,
      reusable: Boolean(gt.reusable),
      rejectionCount: typeof gt.rejectionCount === "number" ? gt.rejectionCount : 1,
      updatedAt: asString(gt.updatedAt) ?? "",
      lastJobId: asString(gt.lastJobId),
      lastReason: asString(gt.lastReason),
      humanConfirmed: Boolean(gt.humanConfirmed),
    })
  }

  return { rows, counts, truncated: snap.docs.length >= SCAN_CAP }
}

export const paAdminRejectedCandidatesSnapshot = onCall(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 120, secrets: [PA_ADMIN_TOKEN] },
  async (req): Promise<AdminRejectedCandidatesResult> => {
    authorizeAdminCallable(req as { auth?: { token?: { admin?: unknown } }; data?: unknown })
    const parsed = AdminRejectedCandidatesInputSchema.safeParse(req.data ?? {})
    if (!parsed.success) throw new HttpsError("invalid-argument", parsed.error.message)
    return runAdminRejectedCandidates(parsed.data, { db: getFirestore() })
  },
)
